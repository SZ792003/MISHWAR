"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.firestoreWalletRepository = exports.firestoreDispatchRepository = exports.firestoreRideRepository = exports.FirestoreWalletRepository = exports.FirestoreDispatchRepository = exports.FirestoreRideRepository = exports.shouldUseFirestorePersistence = void 0;
const auditService_1 = require("./auditService");
const auth_1 = require("./auth");
const config_1 = require("./config");
const shouldUseFirestorePersistence = (authSource) => {
    return authSource === 'firebase' && (config_1.backendConfig.useRealDatabase || (0, config_1.isStrictBackend)());
};
exports.shouldUseFirestorePersistence = shouldUseFirestorePersistence;
const nowIso = () => new Date().toISOString();
const firestoreServerTimestamp = (firebaseAdmin) => {
    const firestoreNamespace = firebaseAdmin.admin.firestore;
    return firestoreNamespace.FieldValue?.serverTimestamp() || nowIso();
};
const idempotencyDocId = (scope, userId, key) => {
    return Buffer.from(`${scope}:${userId}:${key}`).toString('base64url');
};
const terminalRideStatuses = [
    'TRIP_COMPLETED',
    'CANCELLED_BY_CUSTOMER',
    'CANCELLED_BY_PASSENGER',
    'CANCELLED_BY_DRIVER',
    'NO_DRIVER_FOUND',
    'NO_DRIVER_AVAILABLE'
];
const activeRideStatuses = (status) => {
    return Boolean(status) && !terminalRideStatuses.includes(status);
};
const allowedTransitions = {
    REQUESTED: ['SEARCHING_DRIVER', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER'],
    SEARCHING_DRIVER: ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'NO_DRIVER_FOUND', 'NO_DRIVER_AVAILABLE', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER'],
    DRIVER_ASSIGNED: ['DRIVER_ARRIVING', 'DRIVER_ON_THE_WAY', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ARRIVING: ['DRIVER_ARRIVED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ON_THE_WAY: ['DRIVER_ARRIVED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ARRIVED: ['TRIP_STARTED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    TRIP_STARTED: ['TRIP_COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    TRIP_COMPLETED: [],
    CANCELLED_BY_CUSTOMER: [],
    CANCELLED_BY_PASSENGER: [],
    CANCELLED_BY_DRIVER: [],
    NO_DRIVER_FOUND: [],
    NO_DRIVER_AVAILABLE: []
};
const asRide = (data) => data;
const adminContext = async () => {
    const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
    if (!firebaseAdmin)
        throw new Error('DATABASE_UNAVAILABLE');
    return firebaseAdmin;
};
const runFirestoreTransaction = async (firebaseAdmin, callback) => {
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    const runTransaction = db.runTransaction;
    return runTransaction.bind(db)((tx) => callback(tx, db));
};
class FirestoreRideRepository {
    async createRideWithIdempotency(userId, idempotencyKey, ride, actor) {
        const firebaseAdmin = await adminContext();
        const idemId = idempotencyDocId('ride-create', userId, idempotencyKey);
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const idemRef = db.doc(`idempotencyKeys/${idemId}`);
            const idemSnap = await tx.get(idemRef);
            if (idemSnap.exists) {
                return idemSnap.data().response;
            }
            const rideRef = db.doc(`rides/${ride.id}`);
            const now = nowIso();
            const storedRide = { ...ride, createdAt: ride.createdAt || now, updatedAt: now, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) };
            tx.set(rideRef, storedRide);
            tx.set(idemRef, {
                key: idempotencyKey,
                userId,
                scope: 'ride-create',
                response: storedRide,
                createdAt: now,
                serverCreatedAt: firestoreServerTimestamp(firebaseAdmin)
            });
            auditService_1.auditService.logInTransaction(tx, db, {
                ...actor,
                eventType: 'RIDE_CREATED',
                targetType: 'RIDE',
                targetId: ride.id,
                rideId: ride.id,
                metadata: {
                    passengerId: ride.passengerId || ride.customerId,
                    vehicleType: ride.vehicleType,
                    paymentMethod: ride.paymentMethod,
                    fare: ride.fare?.grossFare,
                    currency: ride.fare?.currency || 'YER'
                }
            }, firestoreServerTimestamp(firebaseAdmin));
            return storedRide;
        });
    }
    async getRide(rideId) {
        const firebaseAdmin = await adminContext();
        const snap = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`rides/${rideId}`).get();
        return snap.exists ? asRide(snap.data()) : null;
    }
    async listActiveRideForUser(uid, role) {
        const firebaseAdmin = await adminContext();
        const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
        const field = role === 'DRIVER' ? 'driverId' : 'customerId';
        const query = db.collection('rides').where(field, '==', uid).orderBy('createdAt', 'desc').limit(20);
        const snap = await query.get();
        const rides = snap.docs.map((doc) => asRide(doc.data()));
        return rides.find((ride) => activeRideStatuses(ride.status)) || null;
    }
    async listFirstSearchingRide() {
        const firebaseAdmin = await adminContext();
        const query = firebaseAdmin.admin.firestore(firebaseAdmin.app).collection('rides').where('status', '==', 'SEARCHING_DRIVER').orderBy('createdAt', 'asc').limit(10);
        const snap = await query.get();
        return snap.docs.map((doc) => asRide(doc.data())).find((ride) => !ride.driverId) || null;
    }
    async transitionRide(rideId, nextStatus, patch = {}, audit) {
        const firebaseAdmin = await adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const rideRef = db.doc(`rides/${rideId}`);
            const rideSnap = await tx.get(rideRef);
            if (!rideSnap.exists)
                throw new Error('RIDE_NOT_FOUND');
            const ride = asRide(rideSnap.data());
            if (!allowedTransitions[ride.status]?.includes(nextStatus))
                throw new Error('INVALID_RIDE_TRANSITION');
            const updated = { ...ride, ...patch, status: nextStatus, updatedAt: nowIso(), serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) };
            tx.update(rideRef, updated);
            if (audit) {
                auditService_1.auditService.logInTransaction(tx, db, {
                    ...audit.actor,
                    eventType: audit.eventType,
                    targetType: 'RIDE',
                    targetId: rideId,
                    rideId,
                    metadata: {
                        previousStatus: ride.status,
                        nextStatus,
                        driverId: updated.driverId || null,
                        passengerId: updated.passengerId || updated.customerId
                    }
                }, firestoreServerTimestamp(firebaseAdmin));
            }
            if (ride.driverId && terminalRideStatuses.includes(nextStatus)) {
                tx.set(db.doc(`driverOperational/${ride.driverId}`), {
                    driverId: ride.driverId,
                    currentRideId: null,
                    isAcceptingRides: true,
                    driverStatus: 'ONLINE',
                    updatedAt: nowIso(),
                    serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
                }, { merge: true });
                tx.update(db.doc(`drivers/${ride.driverId}`), {
                    driverStatus: 'ONLINE',
                    isAcceptingRides: true,
                    updatedAt: nowIso(),
                    serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
                });
            }
            return updated;
        });
    }
    async updateDriverLocation(rideId, driverId, location) {
        const firebaseAdmin = await adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const rideRef = db.doc(`rides/${rideId}`);
            const rideSnap = await tx.get(rideRef);
            if (!rideSnap.exists)
                throw new Error('RIDE_NOT_FOUND');
            const ride = asRide(rideSnap.data());
            if (ride.driverId !== driverId)
                throw new Error('RIDE_FORBIDDEN');
            if (terminalRideStatuses.includes(ride.status))
                throw new Error('RIDE_NOT_ACTIVE');
            const locationRef = db.doc(`driverLocations/${driverId}`);
            const locationSnap = await tx.get(locationRef);
            const existingClientUpdatedAt = locationSnap.exists ? locationSnap.data()?.clientUpdatedAt : null;
            if (typeof existingClientUpdatedAt === 'string' &&
                location.clientUpdatedAt &&
                Date.parse(location.clientUpdatedAt) < Date.parse(existingClientUpdatedAt)) {
                throw new Error('LOCATION_STALE');
            }
            const now = nowIso();
            const serverTimestamp = firestoreServerTimestamp(firebaseAdmin);
            const updated = {
                ...ride,
                driverLocation: {
                    latitude: location.latitude,
                    longitude: location.longitude,
                    addressName: 'Current driver location',
                    accuracy: location.accuracy,
                    heading: location.heading,
                    speed: location.speed
                },
                driverLocationUpdatedAt: now,
                updatedAt: now,
                serverUpdatedAt: serverTimestamp
            };
            tx.update(rideRef, updated);
            tx.set(locationRef, {
                driverId,
                rideId,
                latitude: location.latitude,
                longitude: location.longitude,
                accuracy: location.accuracy ?? null,
                heading: location.heading ?? null,
                speed: location.speed ?? null,
                status: ride.status,
                deviceTimestamp: location.clientUpdatedAt || location.updatedAt,
                receivedAt: now,
                clientUpdatedAt: location.clientUpdatedAt || location.updatedAt,
                updatedAt: serverTimestamp,
                serverUpdatedAt: serverTimestamp
            }, { merge: true });
            return updated;
        });
    }
}
exports.FirestoreRideRepository = FirestoreRideRepository;
class FirestoreDispatchRepository {
    async listEligibleDriverIdsForOffer(vehicleType, limitCount = 20) {
        const firebaseAdmin = await adminContext();
        const query = firebaseAdmin.admin.firestore(firebaseAdmin.app).collection('driverOperational').where('isAcceptingRides', '==', true);
        const onlineQuery = query.where('driverStatus', '==', 'ONLINE');
        const snap = await onlineQuery.limit(limitCount).get();
        return snap.docs
            .map((doc) => doc.data())
            .filter((data) => !vehicleType || !Array.isArray(data.vehicleTypes) || data.vehicleTypes.includes(vehicleType))
            .map((data) => data.driverId)
            .filter((driverId) => typeof driverId === 'string' && driverId.length > 0);
    }
    async acceptRide(rideId, driverId, driverName, actor) {
        const firebaseAdmin = await adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const rideRef = db.doc(`rides/${rideId}`);
            const driverOpRef = db.doc(`driverOperational/${driverId}`);
            const kycRef = db.doc(`driverKyc/${driverId}`);
            const driverRef = db.doc(`drivers/${driverId}`);
            const [rideSnap, driverOpSnap, kycSnap] = await Promise.all([
                tx.get(rideRef),
                tx.get(driverOpRef),
                tx.get(kycRef)
            ]);
            if (!rideSnap.exists)
                throw new Error('RIDE_NOT_FOUND');
            const ride = asRide(rideSnap.data());
            if (ride.driverId && ride.driverId !== driverId)
                throw new Error('RIDE_ALREADY_ASSIGNED');
            if (!['REQUESTED', 'SEARCHING_DRIVER'].includes(ride.status))
                throw new Error('RIDE_NOT_AVAILABLE');
            const driverOp = driverOpSnap.exists ? driverOpSnap.data() : null;
            if (driverOp?.currentRideId &&
                driverOp.currentRideId !== rideId &&
                activeRideStatuses(driverOp.currentRideStatus)) {
                throw new Error('DRIVER_ALREADY_BUSY');
            }
            const kyc = kycSnap.exists ? kycSnap.data() : null;
            if (kyc?.kycStatus && kyc.kycStatus !== 'approved')
                throw new Error('DRIVER_NOT_ELIGIBLE');
            const assignedAt = nowIso();
            const updated = {
                ...ride,
                driverId,
                driverName,
                status: 'DRIVER_ARRIVING',
                assignedAt,
                updatedAt: assignedAt,
                serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
            };
            tx.update(rideRef, updated);
            tx.set(driverOpRef, {
                driverId,
                currentRideId: rideId,
                currentRideStatus: updated.status,
                isAcceptingRides: false,
                driverStatus: 'IN_RIDE',
                updatedAt: assignedAt,
                serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
            }, { merge: true });
            tx.update(driverRef, {
                driverStatus: 'IN_RIDE',
                isAcceptingRides: false,
                updatedAt: assignedAt,
                serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
            });
            auditService_1.auditService.logInTransaction(tx, db, {
                ...actor,
                eventType: 'RIDE_ACCEPTED',
                targetType: 'RIDE',
                targetId: rideId,
                rideId,
                metadata: {
                    driverId,
                    previousStatus: ride.status,
                    nextStatus: updated.status
                }
            }, firestoreServerTimestamp(firebaseAdmin));
            return updated;
        });
    }
}
exports.FirestoreDispatchRepository = FirestoreDispatchRepository;
class FirestoreWalletRepository {
    async recordRidePayment(userId, idempotencyKey, input, actor) {
        const firebaseAdmin = await adminContext();
        const idemId = idempotencyDocId('ride-payment', userId, idempotencyKey);
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const idemRef = db.doc(`idempotencyKeys/${idemId}`);
            const idemSnap = await tx.get(idemRef);
            if (idemSnap.exists) {
                return idemSnap.data().response;
            }
            const now = nowIso();
            if (input.method === 'CASH') {
                const response = {
                    transactionId: `tx_cash_${Date.now()}`,
                    rideId: input.rideId,
                    userId,
                    amount: input.amount,
                    method: input.method,
                    status: 'PAID'
                };
                tx.set(db.doc(`payments/${response.transactionId}`), { ...response, createdAt: now, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
                tx.set(idemRef, { key: idempotencyKey, userId, scope: 'ride-payment', response, createdAt: now, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
                auditService_1.auditService.logInTransaction(tx, db, {
                    ...actor,
                    eventType: 'PAYMENT_RECORDED',
                    targetType: 'PAYMENT',
                    targetId: response.transactionId,
                    rideId: input.rideId,
                    source: 'PAYMENT_BACKEND',
                    metadata: {
                        userId,
                        amount: input.amount,
                        currency: 'YER',
                        method: input.method,
                        status: response.status
                    }
                }, firestoreServerTimestamp(firebaseAdmin));
                return response;
            }
            if (input.method !== 'WALLET')
                throw new Error('PAYMENT_METHOD_DISABLED');
            const walletRef = db.doc(`wallets/${userId}`);
            const walletSnap = await tx.get(walletRef);
            const currentBalance = Number(walletSnap.data()?.balance ?? 0);
            const hasFunds = currentBalance >= input.amount;
            const ledgerEntry = {
                transactionId: `tx_wallet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                userId,
                type: 'RIDE_PAYMENT',
                amount: input.amount,
                balanceBefore: currentBalance,
                balanceAfter: hasFunds ? currentBalance - input.amount : currentBalance,
                status: hasFunds ? 'SUCCESS' : 'FAILED',
                referenceId: input.rideId,
                idempotencyKey,
                createdAt: now
            };
            const response = {
                transactionId: ledgerEntry.transactionId,
                status: hasFunds ? 'PAID' : 'FAILED',
                ledgerEntry
            };
            tx.set(db.doc(`walletTransactions/${ledgerEntry.transactionId}`), {
                ...ledgerEntry,
                serverCreatedAt: firestoreServerTimestamp(firebaseAdmin)
            });
            if (hasFunds) {
                tx.set(walletRef, {
                    userId,
                    balance: ledgerEntry.balanceAfter,
                    updatedAt: now,
                    serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
                }, { merge: true });
            }
            tx.set(idemRef, { key: idempotencyKey, userId, scope: 'ride-payment', response, createdAt: now, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            auditService_1.auditService.logInTransaction(tx, db, {
                ...actor,
                eventType: hasFunds ? 'WALLET_DEBIT' : 'PAYMENT_RECORDED',
                targetType: 'WALLET',
                targetId: userId,
                rideId: input.rideId,
                source: 'PAYMENT_BACKEND',
                metadata: {
                    transactionId: ledgerEntry.transactionId,
                    userId,
                    amount: input.amount,
                    currency: 'YER',
                    operationType: ledgerEntry.type,
                    status: ledgerEntry.status,
                    balanceBefore: ledgerEntry.balanceBefore,
                    balanceAfter: ledgerEntry.balanceAfter
                }
            }, firestoreServerTimestamp(firebaseAdmin));
            return response;
        });
    }
}
exports.FirestoreWalletRepository = FirestoreWalletRepository;
exports.firestoreRideRepository = new FirestoreRideRepository();
exports.firestoreDispatchRepository = new FirestoreDispatchRepository();
exports.firestoreWalletRepository = new FirestoreWalletRepository();
