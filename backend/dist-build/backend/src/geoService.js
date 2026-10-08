"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.geoService = exports.GeoService = exports.resetGeoCachesForTests = exports.validateGeoProviderConfig = exports.assertGeoPointModel = exports.isValidCoordinate = void 0;
const src_1 = require("../../packages/shared_utils/src");
const config_1 = require("./config");
const metrics_1 = require("./metrics");
const validation_1 = require("./validation");
const routeCache = new Map();
const reverseCache = new Map();
const providerBackoff = new Map();
const routeCacheTtlMs = 5 * 60 * 1000;
const reverseCacheTtlMs = 12 * 60 * 60 * 1000;
const gridPrecision = 3;
const yemenPlaces = [
    { id: 'ye_sanaa_tahrir', name: 'ميدان التحرير', address: 'صنعاء، اليمن', latitude: 15.3694, longitude: 44.1910, provider: 'internal', type: 'landmark' },
    { id: 'ye_sanaa_hadda', name: 'شارع حدة', address: 'صنعاء، اليمن', latitude: 15.3470, longitude: 44.2060, provider: 'internal', type: 'street' },
    { id: 'ye_sanaa_ring', name: 'شارع الستين', address: 'صنعاء، اليمن', latitude: 15.3557, longitude: 44.1706, provider: 'internal', type: 'street' },
    { id: 'ye_aden_crater', name: 'كريتر', address: 'عدن، اليمن', latitude: 12.7797, longitude: 45.0367, provider: 'internal', type: 'district' },
    { id: 'ye_aden_mansoura', name: 'المنصورة', address: 'عدن، اليمن', latitude: 12.8531, longitude: 44.9717, provider: 'internal', type: 'district' }
];
const isValidCoordinate = (latitude, longitude) => {
    return Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180;
};
exports.isValidCoordinate = isValidCoordinate;
const assertGeoPointModel = (value, fieldName) => {
    const point = (0, validation_1.assertGeoPoint)(value, fieldName);
    return { latitude: point.latitude, longitude: point.longitude };
};
exports.assertGeoPointModel = assertGeoPointModel;
const validateGeoProviderConfig = (config = config_1.backendConfig, strict = (0, config_1.isStrictBackend)()) => {
    const missing = [];
    const geocodingProvider = config.geocodingProvider.toLowerCase();
    const routingProvider = config.routingProvider.toLowerCase();
    if (['google', 'mapbox'].includes(geocodingProvider) && !config.geocodingApiKey)
        missing.push('GEOCODING_API_KEY');
    if (['google', 'mapbox'].includes(routingProvider) && !config.routingApiKey)
        missing.push('ROUTING_API_KEY');
    if (strict && geocodingProvider === 'internal')
        missing.push('GEOCODING_PROVIDER');
    if (strict && routingProvider === 'internal_fallback')
        missing.push('ROUTING_PROVIDER');
    return { valid: missing.length === 0, missing };
};
exports.validateGeoProviderConfig = validateGeoProviderConfig;
const resetGeoCachesForTests = () => {
    routeCache.clear();
    reverseCache.clear();
    providerBackoff.clear();
};
exports.resetGeoCachesForTests = resetGeoCachesForTests;
const roundedDistanceMeters = (origin, destination) => {
    return Math.round((0, src_1.calculateDistanceKm)(origin, destination) * 1000);
};
const coordinateKey = (point) => {
    return `${point.latitude.toFixed(gridPrecision)},${point.longitude.toFixed(gridPrecision)}`;
};
const routeCacheKey = (origin, destination, provider, vehicleType) => {
    return `${provider}:${vehicleType}:${coordinateKey(origin)}:${coordinateKey(destination)}`;
};
const reverseCacheKey = (point, provider) => {
    return `${provider}:${coordinateKey(point)}`;
};
const cacheGet = (cache, key, hitMetric) => {
    const entry = cache.get(key);
    if (!entry)
        return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    metrics_1.metrics.increment(hitMetric);
    return entry.value;
};
const cacheSet = (cache, key, value, ttlMs) => {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
};
const providerAvailable = (provider) => {
    const state = providerBackoff.get(provider);
    return !state || Date.now() >= state.retryAfter;
};
const recordProviderSuccess = (provider) => {
    providerBackoff.delete(provider);
};
const recordProviderFailure = (provider, retryAfterMs) => {
    const previous = providerBackoff.get(provider);
    const failures = Math.min((previous?.failures || 0) + 1, 6);
    const exponentialMs = Math.min(60_000, 1000 * 2 ** (failures - 1));
    providerBackoff.set(provider, {
        failures,
        retryAfter: Date.now() + (retryAfterMs || exponentialMs)
    });
    metrics_1.metrics.increment('geo_provider_failures_total');
};
const retryAfterFromDetails = (details) => {
    if (!details || typeof details !== 'object' || !('retryAfterMs' in details))
        return undefined;
    const value = Number(details.retryAfterMs);
    return Number.isFinite(value) && value > 0 ? value : undefined;
};
const internalRoute = (origin, destination, vehicleType = 'CAR') => {
    const directMeters = roundedDistanceMeters(origin, destination);
    if (directMeters < 10) {
        throw new validation_1.ApiValidationError('NO_ROUTE', 'تعذر العثور على مسار بين الموقعين.');
    }
    const urbanFactor = 1.28;
    const distanceMeters = Math.max(50, Math.round(directMeters * urbanFactor));
    const durationSeconds = (0, src_1.estimateDurationMinutes)(distanceMeters / 1000, vehicleType) * 60;
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
const withTimeout = async (promise, timeoutMs) => {
    let timeout;
    const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            reject(new validation_1.ApiValidationError('GEO_PROVIDER_TIMEOUT', 'Geo provider request timed out'));
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, timer]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
};
const fetchJson = async (url, timeoutMs) => {
    const response = await withTimeout(fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'mishwar-backend/1.0' }
    }), timeoutMs);
    if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new validation_1.ApiValidationError('GEO_PROVIDER_RATE_LIMITED', 'Geo provider rate limited the request', {
            status: 429,
            retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined
        });
    }
    if (!response.ok)
        throw new validation_1.ApiValidationError('GEO_PROVIDER_UNAVAILABLE', 'Geo provider request failed', { status: response.status });
    return response.json();
};
const normalizePlace = (value, provider) => {
    const latitude = Number(value.lat ?? value.latitude);
    const longitude = Number(value.lon ?? value.longitude);
    if (!(0, exports.isValidCoordinate)(latitude, longitude))
        return null;
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
class GeoService {
    config;
    strictMode;
    fetcher;
    constructor(config = config_1.backendConfig, strictMode = (0, config_1.isStrictBackend)(), fetcher = fetchJson) {
        this.config = config;
        this.strictMode = strictMode;
        this.fetcher = fetcher;
    }
    searchPlaces(query, near) {
        metrics_1.metrics.increment('geo_geocode_requests_total');
        const normalized = query.trim().toLowerCase();
        if (normalized.length < 2)
            return Promise.resolve([]);
        const provider = this.config.geocodingProvider.toLowerCase();
        if (this.strictMode && provider === 'internal') {
            throw new validation_1.ApiValidationError('GEO_PROVIDER_CONFIG_MISSING', 'Production geocoding provider is not configured');
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
    async reverseGeocode(point) {
        metrics_1.metrics.increment('geo_geocode_requests_total');
        if (!(0, exports.isValidCoordinate)(point.latitude, point.longitude)) {
            throw new validation_1.ApiValidationError('INVALID_COORDINATES', 'Coordinates are invalid');
        }
        const provider = this.config.geocodingProvider.toLowerCase();
        const key = reverseCacheKey(point, provider);
        const cached = cacheGet(reverseCache, key, 'geo_geocode_cache_hits_total');
        if (cached)
            return cached;
        if (provider === 'nominatim' && this.config.nominatimBaseUrl && providerAvailable('nominatim')) {
            try {
                const url = new URL('/reverse', this.config.nominatimBaseUrl);
                url.searchParams.set('format', 'jsonv2');
                url.searchParams.set('lat', String(point.latitude));
                url.searchParams.set('lon', String(point.longitude));
                url.searchParams.set('accept-language', 'ar');
                const json = await this.fetcher(url.toString(), this.config.geoRequestTimeoutMs);
                const place = normalizePlace(json, 'nominatim');
                if (place) {
                    recordProviderSuccess('nominatim');
                    return cacheSet(reverseCache, key, place, reverseCacheTtlMs);
                }
            }
            catch (error) {
                recordProviderFailure('nominatim', error instanceof validation_1.ApiValidationError ? retryAfterFromDetails(error.details) : undefined);
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
                type: 'manual'
            };
        return cacheSet(reverseCache, key, fallback, reverseCacheTtlMs);
    }
    async route(origin, destination, vehicleType = 'CAR') {
        metrics_1.metrics.increment('geo_route_requests_total');
        if (!(0, exports.isValidCoordinate)(origin.latitude, origin.longitude) || !(0, exports.isValidCoordinate)(destination.latitude, destination.longitude)) {
            metrics_1.metrics.increment('geo_route_failures_total');
            throw new validation_1.ApiValidationError('INVALID_COORDINATES', 'Route coordinates are invalid');
        }
        const provider = this.config.routingProvider.toLowerCase();
        if (this.strictMode && provider === 'internal_fallback') {
            metrics_1.metrics.increment('geo_route_failures_total');
            throw new validation_1.ApiValidationError('GEO_PROVIDER_CONFIG_MISSING', 'Production routing provider is not configured');
        }
        const key = routeCacheKey(origin, destination, provider, vehicleType);
        const cached = cacheGet(routeCache, key, 'geo_route_cache_hits_total');
        if (cached)
            return cached;
        if (provider === 'osrm' && this.config.osrmBaseUrl && !providerAvailable('osrm')) {
            metrics_1.metrics.increment('geo_route_failures_total');
            throw new validation_1.ApiValidationError('GEO_PROVIDER_BACKOFF', 'Routing provider is temporarily backed off and no secondary provider is configured');
        }
        if (provider === 'osrm' && this.config.osrmBaseUrl) {
            try {
                const route = await this.osrmRoute(origin, destination);
                recordProviderSuccess('osrm');
                return cacheSet(routeCache, key, route, routeCacheTtlMs);
            }
            catch (error) {
                recordProviderFailure('osrm', error instanceof validation_1.ApiValidationError ? retryAfterFromDetails(error.details) : undefined);
                if (this.strictMode) {
                    metrics_1.metrics.increment('geo_route_failures_total');
                    throw error;
                }
            }
        }
        const fallback = internalRoute(origin, destination, vehicleType);
        return cacheSet(routeCache, key, fallback, routeCacheTtlMs);
    }
    async routeForRide(pickup, destination, vehicleType) {
        return this.route(pickup, destination, vehicleType);
    }
    async nominatimSearch(query) {
        try {
            const url = new URL('/search', this.config.nominatimBaseUrl);
            url.searchParams.set('format', 'jsonv2');
            url.searchParams.set('q', query);
            url.searchParams.set('countrycodes', this.config.geoCountryBias.toLowerCase());
            url.searchParams.set('limit', '8');
            url.searchParams.set('accept-language', 'ar');
            const json = await this.fetcher(url.toString(), this.config.geoRequestTimeoutMs);
            recordProviderSuccess('nominatim');
            return json
                .map((item) => normalizePlace(item, 'nominatim'))
                .filter((item) => item != null);
        }
        catch (error) {
            recordProviderFailure('nominatim', error instanceof validation_1.ApiValidationError ? retryAfterFromDetails(error.details) : undefined);
            if (this.strictMode)
                throw error;
            return [];
        }
    }
    async osrmRoute(origin, destination) {
        const url = new URL(`/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`, this.config.osrmBaseUrl);
        url.searchParams.set('overview', 'full');
        url.searchParams.set('geometries', 'geojson');
        const json = await this.fetcher(url.toString(), this.config.geoRequestTimeoutMs);
        const route = json.routes?.[0];
        const coordinates = route?.geometry?.coordinates || [];
        const polyline = coordinates
            .map((coordinate) => coordinate)
            .map(([longitude, latitude]) => ({ latitude: Number(latitude), longitude: Number(longitude) }))
            .filter((point) => (0, exports.isValidCoordinate)(point.latitude, point.longitude));
        const distanceMeters = Math.round(Number(route?.distance));
        const durationSeconds = Math.round(Number(route?.duration));
        if (!Number.isFinite(distanceMeters) || distanceMeters < 10 || !Number.isFinite(durationSeconds) || polyline.length < 2) {
            throw new validation_1.ApiValidationError('NO_ROUTE', 'تعذر العثور على مسار بين الموقعين.');
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
exports.GeoService = GeoService;
exports.geoService = new GeoService();
