import assert from 'node:assert/strict';
import { GeoService, assertGeoPointModel, isValidCoordinate, resetGeoCachesForTests, validateGeoProviderConfig } from '../src/geoService';
import { ApiValidationError } from '../src/validation';
import { calculateFare } from '../../packages/shared_utils/src';
import { backendConfig } from '../src/config';

const testConfig = {
  ...backendConfig,
  geocodingProvider: 'internal',
  routingProvider: 'internal_fallback',
  geocodingApiKey: '',
  routingApiKey: '',
  osrmBaseUrl: '',
  nominatimBaseUrl: '',
  geoRequestTimeoutMs: 25
};

const run = async () => {
  resetGeoCachesForTests();
  assert.equal(isValidCoordinate(15.3694, 44.1910), true);
  assert.equal(isValidCoordinate(Number.NaN, 44.1910), false);
  assert.equal(isValidCoordinate(91, 44.1910), false);
  assert.equal(isValidCoordinate(15.3694, 181), false);

  assert.throws(() => assertGeoPointModel({ latitude: Infinity, longitude: 44 }, 'pickup'), ApiValidationError);

  const service = new GeoService(testConfig, false);
  const search = await service.searchPlaces('حدة');
  assert.ok(search.length > 0);
  assert.equal(search[0].provider, 'internal');
  assert.deepEqual(await service.searchPlaces('x'), []);

  const reverse = await service.reverseGeocode({ latitude: 15.3694, longitude: 44.1910 });
  assert.ok(reverse.name.length > 0);

  const fallbackReverse = await service.reverseGeocode({ latitude: 14.1, longitude: 44.1 });
  assert.ok(['manual', 'internal_reverse_fallback'].includes(fallbackReverse.provider));

  const failedReverseService = new GeoService(
    { ...testConfig, geocodingProvider: 'nominatim', nominatimBaseUrl: 'https://geo.example.test' },
    false,
    async () => {
      throw new ApiValidationError('GEO_PROVIDER_UNAVAILABLE', 'provider failed');
    }
  );
  const manualFallback = await failedReverseService.reverseGeocode({ latitude: 10, longitude: 43 });
  assert.equal(manualFallback.provider, 'manual');

  const route = await service.route(
    { latitude: 15.3694, longitude: 44.1910 },
    { latitude: 15.3470, longitude: 44.2060 },
    'ECONOMY'
  );
  assert.ok(route.distanceMeters > 0);
  assert.ok(route.durationSeconds > 0);
  assert.ok(route.polyline.length >= 2);
  assert.equal(route.fallback, true);
  const routeAgain = await service.route(
    { latitude: 15.3694, longitude: 44.1910 },
    { latitude: 15.3470, longitude: 44.2060 },
    'ECONOMY'
  );
  assert.equal(routeAgain.calculatedAt, route.calculatedAt);

  const reverseAgain = await service.reverseGeocode({ latitude: 15.3694, longitude: 44.1910 });
  assert.equal(reverseAgain.id, reverse.id);

  await assert.rejects(
    () => service.route({ latitude: 15.3694, longitude: 44.1910 }, { latitude: 15.3694, longitude: 44.1910 }, 'ECONOMY'),
    /تعذر العثور على مسار/
  );

  const osrmService = new GeoService(
    { ...testConfig, routingProvider: 'osrm', osrmBaseUrl: 'https://routing.example.test' },
    false,
    async () => ({
      routes: [{
        distance: 1234.5,
        duration: 321.2,
        geometry: {
          coordinates: [
            [44.1910, 15.3694],
            [44.2060, 15.3470]
          ]
        }
      }]
    })
  );
  const osrmRoute = await osrmService.route(
    { latitude: 15.3694, longitude: 44.1910 },
    { latitude: 15.3470, longitude: 44.2060 },
    'ECONOMY'
  );
  assert.equal(osrmRoute.provider, 'osrm');
  assert.equal(osrmRoute.distanceMeters, 1235);
  assert.equal(osrmRoute.durationSeconds, 321);

  resetGeoCachesForTests();
  const providerFailure = new GeoService(
    { ...testConfig, routingProvider: 'osrm', osrmBaseUrl: 'https://routing.example.test' },
    true,
    async () => {
      throw new ApiValidationError('GEO_PROVIDER_UNAVAILABLE', 'provider failed');
    }
  );
  await assert.rejects(
    () => providerFailure.route({ latitude: 15.3694, longitude: 44.1910 }, { latitude: 15.3470, longitude: 44.2060 }, 'ECONOMY'),
    /provider failed/
  );
  await assert.rejects(
    () => providerFailure.route({ latitude: 15.3694, longitude: 44.1910 }, { latitude: 15.3470, longitude: 44.2060 }, 'ECONOMY'),
    /backed off|provider failed|Geo provider/
  );

  resetGeoCachesForTests();
  const noRouteService = new GeoService(
    { ...testConfig, routingProvider: 'osrm', osrmBaseUrl: 'https://routing.example.test' },
    true,
    async () => ({ routes: [] })
  );
  await assert.rejects(
    () => noRouteService.route({ latitude: 15.3694, longitude: 44.1910 }, { latitude: 15.3470, longitude: 44.2060 }, 'ECONOMY'),
    /تعذر العثور على مسار/
  );

  resetGeoCachesForTests();
  const timeoutService = new GeoService(
    { ...testConfig, routingProvider: 'osrm', osrmBaseUrl: 'https://routing.example.test' },
    true,
    async (_url, timeoutMs) => new Promise((_, reject) => {
      setTimeout(() => reject(new ApiValidationError('GEO_PROVIDER_TIMEOUT', 'timeout')), timeoutMs);
    })
  );
  await assert.rejects(
    () => timeoutService.route({ latitude: 15.3694, longitude: 44.1910 }, { latitude: 15.3470, longitude: 44.2060 }, 'ECONOMY'),
    /timeout/
  );

  resetGeoCachesForTests();
  const strictInternalConfig = new GeoService(testConfig, true);
  await assert.rejects(
    () => strictInternalConfig.route({ latitude: 15.3694, longitude: 44.1910 }, { latitude: 15.3470, longitude: 44.2060 }, 'ECONOMY'),
    /Production routing provider is not configured/
  );

  const clientFakeDistanceKm = 0.1;
  const trustedDistanceKm = route.distanceMeters / 1000;
  assert.notEqual(Math.round(clientFakeDistanceKm * 10), Math.round(trustedDistanceKm * 10));

  const fare = calculateFare(trustedDistanceKm, Math.ceil(route.durationSeconds / 60), {
    id: 'test',
    vehicleType: 'ECONOMY',
    baseFare: 1200,
    pricePerKm: 350,
    pricePerMinute: 45,
    minimumFare: 1800,
    platformCommissionRate: 0.1,
    peakMultiplier: 1,
    currency: 'YER',
    updatedAt: new Date().toISOString()
  });
  assert.equal(fare.distanceKm, Math.round(trustedDistanceKm * 100) / 100);

  const missingGoogleKey = validateGeoProviderConfig({
    ...testConfig,
    geocodingProvider: 'google',
    routingProvider: 'google',
    geocodingApiKey: '',
    routingApiKey: ''
  }, true);
  assert.equal(missingGoogleKey.valid, false);
  assert.ok(missingGoogleKey.missing.includes('GEOCODING_API_KEY'));
  assert.ok(missingGoogleKey.missing.includes('ROUTING_API_KEY'));

  const strictFallbackConfig = validateGeoProviderConfig(testConfig, true);
  assert.equal(strictFallbackConfig.valid, false);
  assert.ok(strictFallbackConfig.missing.includes('GEOCODING_PROVIDER'));
  assert.ok(strictFallbackConfig.missing.includes('ROUTING_PROVIDER'));

  console.log('PASS geo service smoke tests');
};

run();
