import assert from 'node:assert/strict';
import {
  fcmTokenDocId,
  invalidTokenIndexesFromMulticast,
  isInvalidFcmTokenCode,
  notificationEventKey,
  sanitizeNotificationData
} from '../src/notificationService';

const run = () => {
  const safePayload = sanitizeNotificationData({
    event: 'ride_accepted',
    rideId: 'ride_123',
    status: 'DRIVER_ARRIVING',
    customerPhone: '777000000',
    walletBalance: '10000',
    paymentSecret: 'secret',
    token: 'fcm-token'
  });
  assert.deepEqual(safePayload, {
    event: 'ride_accepted',
    rideId: 'ride_123',
    status: 'DRIVER_ARRIVING'
  });

  assert.equal(isInvalidFcmTokenCode('messaging/registration-token-not-registered'), true);
  assert.equal(isInvalidFcmTokenCode('messaging/internal-error'), false);

  assert.deepEqual(invalidTokenIndexesFromMulticast([
    { success: true },
    { success: false, error: { code: 'messaging/registration-token-not-registered' } },
    { success: false, error: { code: 'messaging/internal-error' } },
    { success: false, error: { code: 'messaging/invalid-registration-token' } }
  ]), [1, 3]);

  assert.equal(notificationEventKey('user_a', 'ride_accepted', 'ride_123'), notificationEventKey('user_a', 'ride_accepted', 'ride_123'));
  assert.notEqual(notificationEventKey('user_a', 'ride_accepted', 'ride_123'), notificationEventKey('user_a', 'ride_started', 'ride_123'));
  assert.match(fcmTokenDocId('user_a', 'token_123'), /^user_a_/);

  console.log('PASS FCM notification hardening smoke tests');
};

run();
