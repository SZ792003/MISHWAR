"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidTokenIndexesFromMulticast = exports.isInvalidFcmTokenCode = exports.sanitizeNotificationData = exports.notificationEventKey = exports.fcmTokenDocId = void 0;
exports.registerDeviceToken = registerDeviceToken;
exports.disableDeviceToken = disableDeviceToken;
exports.notifyUser = notifyUser;
exports.notifyUsers = notifyUsers;
const auth_1 = require("./auth");
const logger_1 = require("./logger");
const memoryDeviceTokens = new Map();
const memoryNotificationEvents = new Set();
const nowIso = () => new Date().toISOString();
const fcmTokenDocId = (userId, token) => {
    return `${userId}_${Buffer.from(token).toString('base64url')}`;
};
exports.fcmTokenDocId = fcmTokenDocId;
const notificationEventKey = (userId, event, rideId) => {
    return Buffer.from(`${userId}:${event}:${rideId || 'global'}`).toString('base64url');
};
exports.notificationEventKey = notificationEventKey;
const sanitizeNotificationData = (data = {}) => {
    const blockedKeys = ['phone', 'token', 'secret', 'kyc', 'wallet', 'balance', 'paymentsecret', 'credential'];
    return Object.fromEntries(Object.entries(data)
        .filter((entry) => typeof entry[1] === 'string' && entry[1].length > 0)
        .filter(([key]) => {
        const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
        return !blockedKeys.some((blocked) => normalized.includes(blocked));
    }));
};
exports.sanitizeNotificationData = sanitizeNotificationData;
const isInvalidFcmTokenCode = (code) => {
    return [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered',
        'messaging/invalid-argument'
    ].includes(code || '');
};
exports.isInvalidFcmTokenCode = isInvalidFcmTokenCode;
const invalidTokenIndexesFromMulticast = (responses = []) => {
    return responses
        .map((response, index) => (!response.success && (0, exports.isInvalidFcmTokenCode)(response.error?.code) ? index : -1))
        .filter((index) => index >= 0);
};
exports.invalidTokenIndexesFromMulticast = invalidTokenIndexesFromMulticast;
async function registerDeviceToken(input) {
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
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (firebaseAdmin) {
        const firestoreNamespace = firebaseAdmin.admin.firestore;
        const serverTimestamp = firestoreNamespace.FieldValue?.serverTimestamp() || record.updatedAt;
        await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`deviceTokens/${(0, exports.fcmTokenDocId)(input.userId, input.token)}`).set({
            ...record,
            serverCreatedAt: serverTimestamp,
            serverUpdatedAt: serverTimestamp,
            serverLastSeenAt: serverTimestamp
        }, { merge: true });
    }
    else {
        const userTokens = memoryDeviceTokens.get(input.userId) || new Map();
        userTokens.set(input.token, record);
        memoryDeviceTokens.set(input.userId, userTokens);
    }
    return record;
}
async function disableDeviceToken(input) {
    const timestamp = nowIso();
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (firebaseAdmin) {
        await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`deviceTokens/${(0, exports.fcmTokenDocId)(input.userId, input.token)}`).set({
            userId: input.userId,
            token: input.token,
            enabled: false,
            disabledAt: timestamp,
            disabledReason: input.reason || 'client_logout',
            updatedAt: timestamp
        }, { merge: true });
    }
    else {
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
async function markNotificationEvent(firebaseAdmin, key, payload) {
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    const ref = db.doc(`notificationEvents/${key}`);
    const snap = await ref.get();
    if (snap.exists)
        return false;
    await ref.set({
        ...payload,
        createdAt: nowIso()
    });
    return true;
}
async function disableInvalidTokens(userId, tokens, invalidIndexes) {
    await Promise.all(invalidIndexes.map((index) => disableDeviceToken({
        userId,
        token: tokens[index],
        reason: 'fcm_invalid_token'
    })));
}
async function notifyUser(input) {
    if (!input.userId)
        return;
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin) {
        if (input.event) {
            memoryNotificationEvents.add((0, exports.notificationEventKey)(input.userId, input.event, input.rideId));
        }
        return;
    }
    const eventKey = input.event ? (0, exports.notificationEventKey)(input.userId, input.event, input.rideId) : null;
    if (eventKey) {
        const shouldSend = await markNotificationEvent(firebaseAdmin, eventKey, {
            userId: input.userId,
            event: input.event,
            rideId: input.rideId || null
        });
        if (!shouldSend)
            return;
    }
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    const query = db.collection('deviceTokens').where('userId', '==', input.userId).limit(20);
    const snap = await query.get();
    const tokens = snap.docs
        .map((doc) => doc.data())
        .filter((data) => data.enabled !== false)
        .map((data) => data.token)
        .filter((token) => typeof token === 'string' && token.length > 0);
    if (tokens.length === 0)
        return;
    const messagingFactory = firebaseAdmin.admin.messaging;
    if (!messagingFactory)
        return;
    try {
        const payloadData = (0, exports.sanitizeNotificationData)({
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
        const invalidIndexes = (0, exports.invalidTokenIndexesFromMulticast)(response.responses || []);
        if (invalidIndexes.length > 0) {
            await disableInvalidTokens(input.userId, tokens, invalidIndexes);
        }
    }
    catch (error) {
        (0, logger_1.logEvent)('warn', 'push_notification_failed', {
            userId: input.userId,
            errorType: error instanceof Error ? error.message : 'UNKNOWN'
        });
    }
}
async function notifyUsers(input) {
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
