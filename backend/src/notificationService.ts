import { UserRole } from '../../packages/shared_types/src';
import { getFirebaseAdmin } from './auth';
import { logEvent } from './logger';

type FirebaseMessagingLike = {
  sendEachForMulticast: (message: {
    tokens: string[];
    notification: { title: string; body: string };
    data?: Record<string, string>;
    android?: Record<string, unknown>;
    apns?: Record<string, unknown>;
  }) => Promise<{
    responses?: Array<{
      success: boolean;
      error?: { code?: string; message?: string };
    }>;
  }>;
};

const memoryDeviceTokens = new Map<string, Map<string, Record<string, unknown>>>();
const memoryNotificationEvents = new Set<string>();

const nowIso = (): string => new Date().toISOString();

export const fcmTokenDocId = (userId: string, token: string): string => {
  return `${userId}_${Buffer.from(token).toString('base64url')}`;
};

export const notificationEventKey = (userId: string, event: string, rideId?: string | null): string => {
  return Buffer.from(`${userId}:${event}:${rideId || 'global'}`).toString('base64url');
};

export const sanitizeNotificationData = (data: Record<string, string | undefined | null> = {}): Record<string, string> => {
  const blockedKeys = ['phone', 'token', 'secret', 'kyc', 'wallet', 'balance', 'paymentsecret', 'credential'];
  return Object.fromEntries(
    Object.entries(data)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
      .filter(([key]) => {
        const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
        return !blockedKeys.some((blocked) => normalized.includes(blocked));
      })
  );
};

export const isInvalidFcmTokenCode = (code?: string): boolean => {
  return [
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
    'messaging/invalid-argument'
  ].includes(code || '');
};

export const invalidTokenIndexesFromMulticast = (responses: Array<{ success: boolean; error?: { code?: string } }> = []): number[] => {
  return responses
    .map((response, index) => (!response.success && isInvalidFcmTokenCode(response.error?.code) ? index : -1))
    .filter((index) => index >= 0);
};

export async function registerDeviceToken(input: {
  userId: string;
  role: UserRole;
  token: string;
  platform: string;
  app?: 'customer' | 'driver';
}) {
  const timestamp = nowIso();
  const record = {
    userId: input.userId,
    role: input.role,
    token: input.token,
    platform: input.platform,
    app: input.app || (input.role === 'DRIVER' ? 'driver' : 'customer'),
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp
  };

  const firebaseAdmin = await getFirebaseAdmin();
  if (firebaseAdmin) {
    const firestoreNamespace = firebaseAdmin.admin.firestore as unknown as {
      FieldValue?: { serverTimestamp: () => unknown };
    };
    const serverTimestamp = firestoreNamespace.FieldValue?.serverTimestamp() || record.updatedAt;
    await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`deviceTokens/${fcmTokenDocId(input.userId, input.token)}`).set({
      ...record,
      serverCreatedAt: serverTimestamp,
      serverUpdatedAt: serverTimestamp,
      serverLastSeenAt: serverTimestamp
    }, { merge: true });
  } else {
    const userTokens = memoryDeviceTokens.get(input.userId) || new Map<string, Record<string, unknown>>();
    userTokens.set(input.token, record);
    memoryDeviceTokens.set(input.userId, userTokens);
  }

  return record;
}

export async function disableDeviceToken(input: {
  userId: string;
  token: string;
  reason?: string;
}) {
  const timestamp = nowIso();
  const firebaseAdmin = await getFirebaseAdmin();
  if (firebaseAdmin) {
    await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`deviceTokens/${fcmTokenDocId(input.userId, input.token)}`).set({
      userId: input.userId,
      token: input.token,
      enabled: false,
      disabledAt: timestamp,
      disabledReason: input.reason || 'client_logout',
      updatedAt: timestamp
    }, { merge: true });
  } else {
    const userTokens = memoryDeviceTokens.get(input.userId);
    const existing = userTokens?.get(input.token);
    if (existing) {
      userTokens?.set(input.token, {
        ...existing,
        enabled: false,
        disabledAt: timestamp,
        disabledReason: input.reason || 'client_logout',
        updatedAt: timestamp
      });
    }
  }

  return { userId: input.userId, token: input.token, enabled: false };
}

async function markNotificationEvent(firebaseAdmin: NonNullable<Awaited<ReturnType<typeof getFirebaseAdmin>>>, key: string, payload: Record<string, unknown>): Promise<boolean> {
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const ref = db.doc(`notificationEvents/${key}`);
  const snap = await ref.get();
  if (snap.exists) return false;
  await ref.set({
    ...payload,
    createdAt: nowIso()
  });
  return true;
}

async function disableInvalidTokens(userId: string, tokens: string[], invalidIndexes: number[]) {
  await Promise.all(invalidIndexes.map((index) => disableDeviceToken({
    userId,
    token: tokens[index],
    reason: 'fcm_invalid_token'
  })));
}

export async function notifyUser(input: {
  userId?: string | null;
  title: string;
  body: string;
  data?: Record<string, string | undefined | null>;
  event?: string;
  rideId?: string | null;
}) {
  if (!input.userId) return;
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) {
    if (input.event) {
      memoryNotificationEvents.add(notificationEventKey(input.userId, input.event, input.rideId));
    }
    return;
  }

  const eventKey = input.event ? notificationEventKey(input.userId, input.event, input.rideId) : null;
  if (eventKey) {
    const shouldSend = await markNotificationEvent(firebaseAdmin, eventKey, {
      userId: input.userId,
      event: input.event,
      rideId: input.rideId || null
    });
    if (!shouldSend) return;
  }

  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const query = (db.collection('deviceTokens') as unknown as {
    where: (field: string, op: string, value: unknown) => {
      limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> };
    };
  }).where('userId', '==', input.userId).limit(20);
  const snap = await query.get();
  const tokens = snap.docs
    .map((doc) => doc.data())
    .filter((data) => data.enabled !== false)
    .map((data) => data.token)
    .filter((token): token is string => typeof token === 'string' && token.length > 0);
  if (tokens.length === 0) return;

  const messagingFactory = firebaseAdmin.admin.messaging as unknown as ((app?: unknown) => FirebaseMessagingLike) | undefined;
  if (!messagingFactory) return;

  try {
    const payloadData = sanitizeNotificationData({
      ...input.data,
      event: input.event || input.data?.event,
      rideId: input.rideId || input.data?.rideId
    });
    const response = await messagingFactory(firebaseAdmin.app).sendEachForMulticast({
      tokens,
      notification: {
        title: input.title,
        body: input.body
      },
      data: payloadData,
      android: {
        priority: 'high',
        notification: {
          channelId: input.event === 'sos' ? 'safety' : 'ride_updates'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    });
    const invalidIndexes = invalidTokenIndexesFromMulticast(response.responses || []);
    if (invalidIndexes.length > 0) {
      await disableInvalidTokens(input.userId, tokens, invalidIndexes);
    }
  } catch (error) {
    logEvent('warn', 'push_notification_failed', {
      userId: input.userId,
      errorType: error instanceof Error ? error.message : 'UNKNOWN'
    });
  }
}

export async function notifyUsers(input: {
  userIds: string[];
  title: string;
  body: string;
  data?: Record<string, string | undefined | null>;
  event: string;
  rideId?: string | null;
}) {
  const uniqueUserIds = Array.from(new Set(input.userIds.filter(Boolean)));
  await Promise.all(uniqueUserIds.map((userId) => notifyUser({
    userId,
    title: input.title,
    body: input.body,
    data: input.data,
    event: input.event,
    rideId: input.rideId
  })));
}
