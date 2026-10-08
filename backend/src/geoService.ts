import { GeoPoint, GeoPointModel, PlaceResult, RouteResult, VehicleType } from '../../packages/shared_types/src';
import { calculateDistanceKm, estimateDurationMinutes } from '../../packages/shared_utils/src';
import { backendConfig, isStrictBackend } from './config';
import { metrics } from './metrics';
import { ApiValidationError, assertGeoPoint } from './validation';

type ProviderConfig = typeof backendConfig;
type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type ProviderBackoff = {
  failures: number;
  retryAfter: number;
};

const routeCache = new Map<string, CacheEntry<RouteResult>>();
const reverseCache = new Map<string, CacheEntry<PlaceResult>>();
const providerBackoff = new Map<string, ProviderBackoff>();

const routeCacheTtlMs = 5 * 60 * 1000;
const reverseCacheTtlMs = 12 * 60 * 60 * 1000;
const gridPrecision = 3;

const yemenPlaces: PlaceResult[] = [
  { id: 'ye_sanaa_tahrir', name: 'ميدان التحرير', address: 'صنعاء، اليمن', latitude: 15.3694, longitude: 44.1910, provider: 'internal', type: 'landmark' },
  { id: 'ye_sanaa_hadda', name: 'شارع حدة', address: 'صنعاء، اليمن', latitude: 15.3470, longitude: 44.2060, provider: 'internal', type: 'street' },
  { id: 'ye_sanaa_ring', name: 'شارع الستين', address: 'صنعاء، اليمن', latitude: 15.3557, longitude: 44.1706, provider: 'internal', type: 'street' },
  { id: 'ye_aden_crater', name: 'كريتر', address: 'عدن، اليمن', latitude: 12.7797, longitude: 45.0367, provider: 'internal', type: 'district' },
  { id: 'ye_aden_mansoura', name: 'المنصورة', address: 'عدن، اليمن', latitude: 12.8531, longitude: 44.9717, provider: 'internal', type: 'district' }
];

export const isValidCoordinate = (latitude: number, longitude: number): boolean => {
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
};

export const assertGeoPointModel = (value: unknown, fieldName: string): GeoPointModel => {
  const point = assertGeoPoint(value, fieldName);
  return { latitude: point.latitude, longitude: point.longitude };
};

export const validateGeoProviderConfig = (
  config: ProviderConfig = backendConfig,
  strict: boolean = isStrictBackend()
): { valid: boolean; missing: string[] } => {
  const missing: string[] = [];
  const geocodingProvider = config.geocodingProvider.toLowerCase();
  const routingProvider = config.routingProvider.toLowerCase();
  if (['google', 'mapbox'].includes(geocodingProvider) && !config.geocodingApiKey) missing.push('GEOCODING_API_KEY');
  if (['google', 'mapbox'].includes(routingProvider) && !config.routingApiKey) missing.push('ROUTING_API_KEY');
  if (strict && geocodingProvider === 'internal') missing.push('GEOCODING_PROVIDER');
  if (strict && routingProvider === 'internal_fallback') missing.push('ROUTING_PROVIDER');
  return { valid: missing.length === 0, missing };
};

export const resetGeoCachesForTests = (): void => {
  routeCache.clear();
  reverseCache.clear();
  providerBackoff.clear();
};

const roundedDistanceMeters = (origin: GeoPointModel, destination: GeoPointModel): number => {
  return Math.round(calculateDistanceKm(origin, destination) * 1000);
};

const coordinateKey = (point: GeoPointModel): string => {
  return `${point.latitude.toFixed(gridPrecision)},${point.longitude.toFixed(gridPrecision)}`;
};

const routeCacheKey = (
  origin: GeoPointModel,
  destination: GeoPointModel,
  provider: string,
  vehicleType: VehicleType
): string => {
  return `${provider}:${vehicleType}:${coordinateKey(origin)}:${coordinateKey(destination)}`;
};

const reverseCacheKey = (point: GeoPointModel, provider: string): string => {
  return `${provider}:${coordinateKey(point)}`;
};

const cacheGet = <T>(cache: Map<string, CacheEntry<T>>, key: string, hitMetric: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  metrics.increment(hitMetric);
  return entry.value;
};

const cacheSet = <T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T => {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
};

const providerAvailable = (provider: string): boolean => {
  const state = providerBackoff.get(provider);
  return !state || Date.now() >= state.retryAfter;
};

const recordProviderSuccess = (provider: string): void => {
  providerBackoff.delete(provider);
};

const recordProviderFailure = (provider: string, retryAfterMs?: number): void => {
  const previous = providerBackoff.get(provider);
  const failures = Math.min((previous?.failures || 0) + 1, 6);
  const exponentialMs = Math.min(60_000, 1000 * 2 ** (failures - 1));
  providerBackoff.set(provider, {
    failures,
    retryAfter: Date.now() + (retryAfterMs || exponentialMs)
  });
  metrics.increment('geo_provider_failures_total');
};

const retryAfterFromDetails = (details: unknown): number | undefined => {
  if (!details || typeof details !== 'object' || !('retryAfterMs' in details)) return undefined;
  const value = Number((details as { retryAfterMs?: unknown }).retryAfterMs);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const internalRoute = (origin: GeoPointModel, destination: GeoPointModel, vehicleType: VehicleType = 'CAR'): RouteResult => {
  const directMeters = roundedDistanceMeters(origin, destination);
  if (directMeters < 10) {
    throw new ApiValidationError('NO_ROUTE', 'تعذر العثور على مسار بين الموقعين.');
  }
  const urbanFactor = 1.28;
  const distanceMeters = Math.max(50, Math.round(directMeters * urbanFactor));
  const durationSeconds = estimateDurationMinutes(distanceMeters / 1000, vehicleType) * 60;
  return {
    origin,
    destination,
    distanceMeters,
    durationSeconds,
    polyline: [origin, destination],
    provider: 'internal_fallback',
    calculatedAt: new Date().toISOString(),
    fallback: true
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ApiValidationError('GEO_PROVIDER_TIMEOUT', 'Geo provider request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const fetchJson: FetchJson = async (url: string, timeoutMs: number): Promise<unknown> => {
  const response = await withTimeout(fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'mishwar-backend/1.0' }
  }), timeoutMs);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiValidationError('GEO_PROVIDER_RATE_LIMITED', 'Geo provider rate limited the request', {
      status: 429,
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined
    });
  }
  if (!response.ok) throw new ApiValidationError('GEO_PROVIDER_UNAVAILABLE', 'Geo provider request failed', { status: response.status });
  return response.json();
};

const normalizePlace = (value: Record<string, unknown>, provider: string): PlaceResult | null => {
  const latitude = Number(value.lat ?? value.latitude);
  const longitude = Number(value.lon ?? value.longitude);
  if (!isValidCoordinate(latitude, longitude)) return null;
  const name = String(value.name || value.display_name || value.address || 'مكان');
  return {
    id: String(value.place_id || value.id || `${provider}_${latitude}_${longitude}`),
    name,
    address: String(value.display_name || value.address || name),
    latitude,
    longitude,
    provider,
    type: 'unknown'
  };
};

export class GeoService {
  constructor(
    private readonly config: ProviderConfig = backendConfig,
    private readonly strictMode: boolean = isStrictBackend(),
    private readonly fetcher: FetchJson = fetchJson
  ) {}

  searchPlaces(query: string, near?: GeoPointModel): Promise<PlaceResult[]> {
    metrics.increment('geo_geocode_requests_total');
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return Promise.resolve([]);
    const provider = this.config.geocodingProvider.toLowerCase();
    if (this.strictMode && provider === 'internal') {
      throw new ApiValidationError('GEO_PROVIDER_CONFIG_MISSING', 'Production geocoding provider is not configured');
    }
    if (provider === 'nominatim' && this.config.nominatimBaseUrl && providerAvailable('nominatim')) {
      return this.nominatimSearch(query);
    }
    const results = yemenPlaces
      .filter((place) => `${place.name} ${place.address}`.toLowerCase().includes(normalized))
      .map((place) => ({
        ...place,
        distanceMeters: near ? roundedDistanceMeters(near, place) : undefined
      }))
      .sort((left, right) => (left.distanceMeters ?? 0) - (right.distanceMeters ?? 0));
    return Promise.resolve(results);
  }

  async reverseGeocode(point: GeoPointModel): Promise<PlaceResult> {
    metrics.increment('geo_geocode_requests_total');
    if (!isValidCoordinate(point.latitude, point.longitude)) {
      throw new ApiValidationError('INVALID_COORDINATES', 'Coordinates are invalid');
    }
    const provider = this.config.geocodingProvider.toLowerCase();
    const key = reverseCacheKey(point, provider);
    const cached = cacheGet(reverseCache, key, 'geo_geocode_cache_hits_total');
    if (cached) return cached;

    if (provider === 'nominatim' && this.config.nominatimBaseUrl && providerAvailable('nominatim')) {
      try {
        const url = new URL('/reverse', this.config.nominatimBaseUrl);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('lat', String(point.latitude));
        url.searchParams.set('lon', String(point.longitude));
        url.searchParams.set('accept-language', 'ar');
        const json = await this.fetcher(url.toString(), this.config.geoRequestTimeoutMs) as Record<string, unknown>;
        const place = normalizePlace(json, 'nominatim');
        if (place) {
          recordProviderSuccess('nominatim');
          return cacheSet(reverseCache, key, place, reverseCacheTtlMs);
        }
      } catch (error) {
        recordProviderFailure('nominatim', error instanceof ApiValidationError ? retryAfterFromDetails(error.details) : undefined);
      }
    }

    const nearest = yemenPlaces
      .map((place) => ({ ...place, distanceMeters: roundedDistanceMeters(point, place) }))
      .sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
    const fallback = nearest && nearest.distanceMeters < 5000
      ? { ...nearest, provider: 'internal_reverse_fallback' }
      : {
          id: `manual_${point.latitude}_${point.longitude}`,
          name: 'موقع محدد على الخريطة',
          address: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
          latitude: point.latitude,
          longitude: point.longitude,
          provider: 'manual',
          type: 'manual' as const
        };
    return cacheSet(reverseCache, key, fallback, reverseCacheTtlMs);
  }

  async route(origin: GeoPointModel, destination: GeoPointModel, vehicleType: VehicleType = 'CAR'): Promise<RouteResult> {
    metrics.increment('geo_route_requests_total');
    if (!isValidCoordinate(origin.latitude, origin.longitude) || !isValidCoordinate(destination.latitude, destination.longitude)) {
      metrics.increment('geo_route_failures_total');
      throw new ApiValidationError('INVALID_COORDINATES', 'Route coordinates are invalid');
    }
    const provider = this.config.routingProvider.toLowerCase();
    if (this.strictMode && provider === 'internal_fallback') {
      metrics.increment('geo_route_failures_total');
      throw new ApiValidationError('GEO_PROVIDER_CONFIG_MISSING', 'Production routing provider is not configured');
    }

    const key = routeCacheKey(origin, destination, provider, vehicleType);
    const cached = cacheGet(routeCache, key, 'geo_route_cache_hits_total');
    if (cached) return cached;

    if (provider === 'osrm' && this.config.osrmBaseUrl && !providerAvailable('osrm')) {
      metrics.increment('geo_route_failures_total');
      throw new ApiValidationError('GEO_PROVIDER_BACKOFF', 'Routing provider is temporarily backed off and no secondary provider is configured');
    }

    if (provider === 'osrm' && this.config.osrmBaseUrl) {
      try {
        const route = await this.osrmRoute(origin, destination);
        recordProviderSuccess('osrm');
        return cacheSet(routeCache, key, route, routeCacheTtlMs);
      } catch (error) {
        recordProviderFailure('osrm', error instanceof ApiValidationError ? retryAfterFromDetails(error.details) : undefined);
        if (this.strictMode) {
          metrics.increment('geo_route_failures_total');
          throw error;
        }
      }
    }

    const fallback = internalRoute(origin, destination, vehicleType);
    return cacheSet(routeCache, key, fallback, routeCacheTtlMs);
  }

  async routeForRide(pickup: GeoPoint, destination: GeoPoint, vehicleType: VehicleType): Promise<RouteResult> {
    return this.route(pickup, destination, vehicleType);
  }

  private async nominatimSearch(query: string): Promise<PlaceResult[]> {
    try {
      const url = new URL('/search', this.config.nominatimBaseUrl);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('q', query);
      url.searchParams.set('countrycodes', this.config.geoCountryBias.toLowerCase());
      url.searchParams.set('limit', '8');
      url.searchParams.set('accept-language', 'ar');
      const json = await this.fetcher(url.toString(), this.config.geoRequestTimeoutMs) as unknown[];
      recordProviderSuccess('nominatim');
      return json
        .map((item) => normalizePlace(item as Record<string, unknown>, 'nominatim'))
        .filter((item): item is PlaceResult => item != null);
    } catch (error) {
      recordProviderFailure('nominatim', error instanceof ApiValidationError ? retryAfterFromDetails(error.details) : undefined);
      if (this.strictMode) throw error;
      return [];
    }
  }

  private async osrmRoute(origin: GeoPointModel, destination: GeoPointModel): Promise<RouteResult> {
    const url = new URL(`/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`, this.config.osrmBaseUrl);
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'geojson');
    const json = await this.fetcher(url.toString(), this.config.geoRequestTimeoutMs) as { routes?: Array<Record<string, unknown>> };
    const route = json.routes?.[0];
    const coordinates = ((route?.geometry as Record<string, unknown> | undefined)?.coordinates as unknown[]) || [];
    const polyline = coordinates
      .map((coordinate) => coordinate as [number, number])
      .map(([longitude, latitude]) => ({ latitude: Number(latitude), longitude: Number(longitude) }))
      .filter((point) => isValidCoordinate(point.latitude, point.longitude));
    const distanceMeters = Math.round(Number(route?.distance));
    const durationSeconds = Math.round(Number(route?.duration));
    if (!Number.isFinite(distanceMeters) || distanceMeters < 10 || !Number.isFinite(durationSeconds) || polyline.length < 2) {
      throw new ApiValidationError('NO_ROUTE', 'تعذر العثور على مسار بين الموقعين.');
    }
    return {
      origin,
      destination,
      distanceMeters,
      durationSeconds,
      polyline,
      provider: 'osrm',
      calculatedAt: new Date().toISOString()
    };
  }
}

export const geoService = new GeoService();
