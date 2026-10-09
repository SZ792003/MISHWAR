import { DriverLiveLocation, PaymentMethod, Ride, RideOffer, RideStatus, WalletLedgerEntry } from '../../packages/shared_types/src';
import { AuditActor, AuditEventType, auditService } from './auditService';
import { getFirebaseAdmin } from './auth';
import { backendConfig, isStrictBackend } from './config';

type FirebaseContext = NonNullable<Awaited<ReturnType<typeof getFirebaseAdmin>>>;
type FirestoreDb = ReturnType<FirebaseContext['admin']['firestore']>;
type FirestoreTransaction = {
  get: (ref: unknown) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  update: (ref: unknown, data: Record<string, unknown>) => void;
};

type IdempotencyRecord<T> = {
  key: string;
  userId: string;
  response: T;
  createdAt: string;
};

export type RidePersistenceMode = 'memory' | 'firestore';

export const shouldUseFirestorePersistence = (authSource?: 'firebase' | 'demo'): boolean => {
  return authSource === 'firebase' && (backendConfig.useRealDatabase || isStrictBackend());
};

const nowIso = (): string => new Date().toISOString();

const firestoreServerTimestamp = (firebaseAdmin: FirebaseContext): unknown => {
  const firestoreNamespace = firebaseAdmin.admin.firestore as unknown as {
    FieldValue?: { serverTimestamp: () => unknown };
  };
  return firestoreNamespace.FieldValue?.serverTimestamp() || nowIso();
};

const idempotencyDocId = (scope: string, userId: string, key: string): string => {
  return Buffer.from(`${scope}:${userId}:${key}`).toString('base64url');
};

const terminalRideStatuses: RideStatus[] = [
  'TRIP_COMPLETED',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_PASSENGER',
  'CANCELLED_BY_DRIVER',
  'NO_DRIVER_FOUND',
  'NO_DRIVER_AVAILABLE'
];

const activeRideStatuses = (status?: RideStatus): boolean => {
  return Boolean(status) && !terminalRideStatuses.includes(status!);
};

const allowedTransitions: Record<RideStatus, RideStatus[]> = {
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

const asRide = (data: Record<string, unknown> | undefined): Ride => data as unknown as Ride;
const asRideOffer = (data: Record<string, unknown> | undefined): RideOffer => data as unknown as RideOffer;
const rideOfferDocId = (rideId: string, driverId: string): string => `${rideId}_${driverId}`;
const rideOfferExpired = (offer: RideOffer, now = nowIso()): boolean => Date.parse(offer.expiresAt) <= Date.parse(now);

const adminContext = async (): Promise<FirebaseContext> => {
  const firebaseAdmin = await getFirebaseAdmin();
  if (!firebaseAdmin) throw new Error('DATABASE_UNAVAILABLE');
  return firebaseAdmin;
};

const runFirestoreTransaction = async <T>(
  firebaseAdmin: FirebaseContext,
  callback: (tx: FirestoreTransaction, db: FirestoreDb) => Promise<T>
): Promise<T> => {
  const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
  const runTransaction = (db as unknown as { runTransaction: <R>(cb: (tx: FirestoreTransaction) => Promise<R>) => Promise<R> }).runTransaction;
  return runTransaction.bind(db)((tx) => callback(tx, db));
};

export class FirestoreRideRepository {
  async createRideWithIdempotency(userId: string, idempotencyKey: string, ride: Ride, actor: AuditActor): Promise<Ride> {
    const firebaseAdmin = await adminContext();
    const idemId = idempotencyDocId('ride-create', userId, idempotencyKey);
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idemId}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) {
        return (idemSnap.data() as IdempotencyRecord<Ride>).response;
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
      auditService.logInTransaction(tx, db, {
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

  async getRide(rideId: string): Promise<Ride | null> {
    const firebaseAdmin = await adminContext();
    const snap = await firebaseAdmin.admin.firestore(firebaseAdmin.app).doc(`rides/${rideId}`).get();
    return snap.exists ? asRide(snap.data()) : null;
  }

  async listActiveRideForUser(uid: string, role: 'CUSTOMER' | 'DRIVER'): Promise<Ride | null> {
    const firebaseAdmin = await adminContext();
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app) as unknown as {
      collection: (path: string) => {
        where: (field: string, op: string, value: unknown) => unknown;
      };
    };
    const field = role === 'DRIVER' ? 'driverId' : 'customerId';
    const query = (db.collection('rides').where(field, '==', uid) as unknown as {
      orderBy: (field: string, direction: 'desc') => { limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> } };
    }).orderBy('createdAt', 'desc').limit(20);
    const snap = await query.get();
    const rides = snap.docs.map((doc) => asRide(doc.data()));
    return rides.find((ride) => activeRideStatuses(ride.status)) || null;
  }

  async listSearchingRidesForDriver(driverId: string): Promise<Ride[]> {
    const firebaseAdmin = await adminContext();
    const query = (firebaseAdmin.admin.firestore(firebaseAdmin.app).collection('rides') as unknown as {
      where: (field: string, op: string, value: unknown) => {
        orderBy: (field: string, direction: 'asc') => { limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> } };
      };
    }).where('status', '==', 'SEARCHING_DRIVER').orderBy('createdAt', 'asc').limit(20);
    const snap = await query.get();
    return snap.docs
      .map((doc) => asRide(doc.data()))
      .filter((ride) => !ride.driverId && !ride.declinedByDriverIds?.includes(driverId));
  }

  async declineRide(rideId: string, driverId: string, actor: AuditActor): Promise<Ride> {
    const firebaseAdmin = await adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const rideRef = db.doc(`rides/${rideId}`);
      const lockRef = db.doc(`rideOfferLocks/${rideId}`);
      const [rideSnap, lockSnap] = await Promise.all([tx.get(rideRef), tx.get(lockRef)]);
      if (!rideSnap.exists) throw new Error('RIDE_NOT_FOUND');
      const ride = asRide(rideSnap.data());
      if (ride.status !== 'SEARCHING_DRIVER' || ride.driverId) throw new Error('RIDE_NOT_AVAILABLE');

      const declinedByDriverIds = Array.from(new Set([...(ride.declinedByDriverIds || []), driverId]));
      const now = nowIso();
      const offerId = rideOfferDocId(rideId, driverId);
      const updated = { ...ride, declinedByDriverIds, updatedAt: now, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) };
      tx.update(rideRef, { declinedByDriverIds, updatedAt: updated.updatedAt, serverUpdatedAt: updated.serverUpdatedAt });
      tx.set(db.doc(`rideOffers/${offerId}`), {
        status: 'REJECTED',
        rejectedAt: now,
        updatedAt: now,
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      }, { merge: true });
      if (lockSnap.exists && lockSnap.data()?.driverId === driverId && lockSnap.data()?.status === 'PENDING') {
        tx.set(lockRef, {
          status: 'REJECTED',
          rejectedAt: now,
          updatedAt: now,
          serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
        }, { merge: true });
      }
      auditService.logInTransaction(tx, db, {
        ...actor,
        eventType: 'RIDE_DECLINED',
        targetType: 'RIDE',
        targetId: rideId,
        rideId,
        metadata: { status: ride.status, driverId, declinedCount: declinedByDriverIds.length }
      }, firestoreServerTimestamp(firebaseAdmin));
      return updated;
    });
  }

  async transitionRide(
    rideId: string,
    nextStatus: RideStatus,
    patch: Partial<Ride> = {},
    audit?: { actor: AuditActor; eventType: AuditEventType }
  ): Promise<Ride> {
    const firebaseAdmin = await adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const rideRef = db.doc(`rides/${rideId}`);
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) throw new Error('RIDE_NOT_FOUND');
      const ride = asRide(rideSnap.data());
      if (!allowedTransitions[ride.status]?.includes(nextStatus)) throw new Error('INVALID_RIDE_TRANSITION');

      const updated = { ...ride, ...patch, status: nextStatus, updatedAt: nowIso(), serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) };
      tx.update(rideRef, updated as unknown as Record<string, unknown>);
      if (audit) {
        auditService.logInTransaction(tx, db, {
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

  async updateDriverLocation(rideId: string, driverId: string, location: DriverLiveLocation): Promise<Ride> {
    const firebaseAdmin = await adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const rideRef = db.doc(`rides/${rideId}`);
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) throw new Error('RIDE_NOT_FOUND');
      const ride = asRide(rideSnap.data());
      if (ride.driverId !== driverId) throw new Error('RIDE_FORBIDDEN');
      if (terminalRideStatuses.includes(ride.status)) throw new Error('RIDE_NOT_ACTIVE');

      const locationRef = db.doc(`driverLocations/${driverId}`);
      const locationSnap = await tx.get(locationRef);
      const existingClientUpdatedAt = locationSnap.exists ? locationSnap.data()?.clientUpdatedAt : null;
      if (
        typeof existingClientUpdatedAt === 'string' &&
        location.clientUpdatedAt &&
        Date.parse(location.clientUpdatedAt) < Date.parse(existingClientUpdatedAt)
      ) {
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
      tx.update(rideRef, updated as unknown as Record<string, unknown>);
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

export class FirestoreDispatchRepository {
  async getOrCreateOfferForDriver(driverId: string, candidateRides: Ride[], ttlMs: number): Promise<Ride | null> {
    const activeRide = await this.findActiveOfferRideForDriver(driverId);
    if (activeRide) return activeRide;

    for (const ride of candidateRides) {
      try {
        return await this.createOfferForRide(ride.id, driverId, ttlMs);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if ([
          'RIDE_NOT_AVAILABLE',
          'OFFER_LOCKED',
          'OFFER_ALREADY_SEEN',
          'DRIVER_ALREADY_BUSY',
          'DRIVER_NOT_ELIGIBLE'
        ].includes(code)) {
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  private async findActiveOfferRideForDriver(driverId: string): Promise<Ride | null> {
    const firebaseAdmin = await adminContext();
    const now = nowIso();
    const query = (firebaseAdmin.admin.firestore(firebaseAdmin.app).collection('rideOffers') as unknown as {
      where: (field: string, op: string, value: unknown) => unknown;
    }).where('driverId', '==', driverId) as unknown as {
      where: (field: string, op: string, value: unknown) => {
        orderBy: (field: string, direction: 'desc') => { limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> } };
      };
    };
    const snap = await query.where('status', '==', 'PENDING').orderBy('createdAt', 'desc').limit(20).get();
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    for (const doc of snap.docs) {
      const offer = asRideOffer(doc.data());
      if (rideOfferExpired(offer, now)) {
        await this.expireOffer(offer.rideId, offer.driverId);
        continue;
      }
      const rideSnap = await db.doc(`rides/${offer.rideId}`).get();
      if (!rideSnap.exists) {
        await this.expireOffer(offer.rideId, offer.driverId);
        continue;
      }
      const ride = asRide(rideSnap.data());
      if (ride.status === 'SEARCHING_DRIVER' && !ride.driverId) return ride;
      await this.expireOffer(offer.rideId, offer.driverId);
    }
    return null;
  }

  private async createOfferForRide(rideId: string, driverId: string, ttlMs: number): Promise<Ride> {
    const firebaseAdmin = await adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const offerId = rideOfferDocId(rideId, driverId);
      const rideRef = db.doc(`rides/${rideId}`);
      const offerRef = db.doc(`rideOffers/${offerId}`);
      const lockRef = db.doc(`rideOfferLocks/${rideId}`);
      const driverOpRef = db.doc(`driverOperational/${driverId}`);
      const kycRef = db.doc(`driverKyc/${driverId}`);

      const [rideSnap, offerSnap, lockSnap, driverOpSnap, kycSnap] = await Promise.all([
        tx.get(rideRef),
        tx.get(offerRef),
        tx.get(lockRef),
        tx.get(driverOpRef),
        tx.get(kycRef)
      ]);

      if (!rideSnap.exists) throw new Error('RIDE_NOT_FOUND');
      const ride = asRide(rideSnap.data());
      if (ride.status !== 'SEARCHING_DRIVER' || ride.driverId || ride.declinedByDriverIds?.includes(driverId)) {
        throw new Error('RIDE_NOT_AVAILABLE');
      }

      const now = nowIso();
      if (offerSnap.exists) {
        const existingOffer = asRideOffer(offerSnap.data());
        if (existingOffer.status === 'PENDING' && !rideOfferExpired(existingOffer, now)) return ride;
        throw new Error('OFFER_ALREADY_SEEN');
      }

      const driverOp = driverOpSnap.exists ? driverOpSnap.data() : null;
      if (
        driverOp?.currentRideId &&
        driverOp.currentRideId !== rideId &&
        activeRideStatuses(driverOp.currentRideStatus as RideStatus | undefined)
      ) {
        throw new Error('DRIVER_ALREADY_BUSY');
      }

      const kyc = kycSnap.exists ? kycSnap.data() : null;
      if (kyc?.kycStatus && kyc.kycStatus !== 'approved') throw new Error('DRIVER_NOT_ELIGIBLE');

      if (lockSnap.exists) {
        const lock = lockSnap.data() || {};
        const lockedForOtherDriver = lock.driverId !== driverId && lock.status === 'PENDING' && typeof lock.expiresAt === 'string' && Date.parse(lock.expiresAt) > Date.parse(now);
        if (lockedForOtherDriver) throw new Error('OFFER_LOCKED');
        if (lock.status === 'PENDING' && typeof lock.offerId === 'string' && typeof lock.driverId === 'string') {
          tx.set(db.doc(`rideOffers/${lock.offerId}`), {
            status: 'EXPIRED',
            expiredAt: now,
            updatedAt: now,
            serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
          }, { merge: true });
        }
      }

      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      const offer: RideOffer = {
        id: offerId,
        rideId,
        driverId,
        status: 'PENDING',
        createdAt: now,
        expiresAt
      };
      const stampedOffer = {
        ...offer,
        updatedAt: now,
        serverCreatedAt: firestoreServerTimestamp(firebaseAdmin),
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      };
      tx.set(offerRef, stampedOffer as unknown as Record<string, unknown>);
      tx.set(lockRef, {
        rideId,
        offerId,
        driverId,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        expiresAt,
        serverCreatedAt: firestoreServerTimestamp(firebaseAdmin),
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      });
      return ride;
    });
  }

  async expireOffer(rideId: string, driverId: string): Promise<void> {
    const firebaseAdmin = await adminContext();
    await runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const offerId = rideOfferDocId(rideId, driverId);
      const offerRef = db.doc(`rideOffers/${offerId}`);
      const lockRef = db.doc(`rideOfferLocks/${rideId}`);
      const [offerSnap, lockSnap] = await Promise.all([tx.get(offerRef), tx.get(lockRef)]);
      const now = nowIso();
      if (offerSnap.exists) {
        const offer = asRideOffer(offerSnap.data());
        if (offer.status === 'PENDING') {
          tx.set(offerRef, {
            status: 'EXPIRED',
            expiredAt: now,
            updatedAt: now,
            serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
          }, { merge: true });
        }
      }
      if (lockSnap.exists && lockSnap.data()?.offerId === offerId && lockSnap.data()?.status === 'PENDING') {
        tx.set(lockRef, {
          status: 'EXPIRED',
          expiredAt: now,
          updatedAt: now,
          serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
        }, { merge: true });
      }
    });
  }

  async listEligibleDriverIdsForOffer(vehicleType?: string, limitCount = 20): Promise<string[]> {
    const firebaseAdmin = await adminContext();
    const query = (firebaseAdmin.admin.firestore(firebaseAdmin.app).collection('driverOperational') as unknown as {
      where: (field: string, op: string, value: unknown) => unknown;
    }).where('isAcceptingRides', '==', true) as unknown as {
      where: (field: string, op: string, value: unknown) => unknown;
      limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> };
    };
    const onlineQuery = query.where('driverStatus', '==', 'ONLINE') as unknown as {
      limit: (count: number) => { get: () => Promise<{ docs: Array<{ data: () => Record<string, unknown> }> }> };
    };
    const snap = await onlineQuery.limit(limitCount).get();
    return snap.docs
      .map((doc) => doc.data())
      .filter((data) => !vehicleType || !Array.isArray(data.vehicleTypes) || data.vehicleTypes.includes(vehicleType))
      .map((data) => data.driverId)
      .filter((driverId): driverId is string => typeof driverId === 'string' && driverId.length > 0);
  }

  async acceptRide(rideId: string, driverId: string, driverName: string, actor: AuditActor): Promise<Ride> {
    const firebaseAdmin = await adminContext();
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const rideRef = db.doc(`rides/${rideId}`);
      const offerId = rideOfferDocId(rideId, driverId);
      const offerRef = db.doc(`rideOffers/${offerId}`);
      const lockRef = db.doc(`rideOfferLocks/${rideId}`);
      const driverOpRef = db.doc(`driverOperational/${driverId}`);
      const kycRef = db.doc(`driverKyc/${driverId}`);
      const driverRef = db.doc(`drivers/${driverId}`);

      const [rideSnap, offerSnap, lockSnap, driverOpSnap, kycSnap] = await Promise.all([
        tx.get(rideRef),
        tx.get(offerRef),
        tx.get(lockRef),
        tx.get(driverOpRef),
        tx.get(kycRef)
      ]);

      if (!rideSnap.exists) throw new Error('RIDE_NOT_FOUND');
      const ride = asRide(rideSnap.data());
      if (ride.driverId && ride.driverId !== driverId) throw new Error('RIDE_ALREADY_ASSIGNED');
      if (!['REQUESTED', 'SEARCHING_DRIVER'].includes(ride.status)) throw new Error('RIDE_NOT_AVAILABLE');
      const now = nowIso();

      if (!ride.driverId) {
        if (!offerSnap.exists) throw new Error('OFFER_REQUIRED');
        const offer = asRideOffer(offerSnap.data());
        if (offer.status !== 'PENDING') throw new Error('OFFER_NOT_AVAILABLE');
        if (rideOfferExpired(offer, now)) {
          tx.set(offerRef, {
            status: 'EXPIRED',
            expiredAt: now,
            updatedAt: now,
            serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
          }, { merge: true });
          if (lockSnap.exists && lockSnap.data()?.offerId === offerId) {
            tx.set(lockRef, {
              status: 'EXPIRED',
              expiredAt: now,
              updatedAt: now,
              serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
            }, { merge: true });
          }
          throw new Error('OFFER_EXPIRED');
        }
      }

      const driverOp = driverOpSnap.exists ? driverOpSnap.data() : null;
      if (
        driverOp?.currentRideId &&
        driverOp.currentRideId !== rideId &&
        activeRideStatuses(driverOp.currentRideStatus as RideStatus | undefined)
      ) {
        throw new Error('DRIVER_ALREADY_BUSY');
      }

      const kyc = kycSnap.exists ? kycSnap.data() : null;
      if (kyc?.kycStatus && kyc.kycStatus !== 'approved') throw new Error('DRIVER_NOT_ELIGIBLE');

      const assignedAt = now;
      const updated: Ride = {
        ...ride,
        driverId,
        driverName,
        status: 'DRIVER_ARRIVING',
        assignedAt,
        updatedAt: assignedAt,
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      } as Ride;

      tx.update(rideRef, updated as unknown as Record<string, unknown>);
      tx.set(offerRef, {
        status: 'ACCEPTED',
        acceptedAt: assignedAt,
        updatedAt: assignedAt,
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      }, { merge: true });
      tx.set(lockRef, {
        rideId,
        offerId,
        driverId,
        status: 'ACCEPTED',
        acceptedAt: assignedAt,
        updatedAt: assignedAt,
        serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin)
      }, { merge: true });
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
      auditService.logInTransaction(tx, db, {
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

export class FirestoreWalletRepository {
  async recordRidePayment(
    userId: string,
    idempotencyKey: string,
    input: { rideId: string; amount: number; method: PaymentMethod },
    actor: AuditActor
  ): Promise<Record<string, unknown>> {
    const firebaseAdmin = await adminContext();
    const idemId = idempotencyDocId('ride-payment', userId, idempotencyKey);
    return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
      const idemRef = db.doc(`idempotencyKeys/${idemId}`);
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) {
        return (idemSnap.data() as IdempotencyRecord<Record<string, unknown>>).response;
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
        auditService.logInTransaction(tx, db, {
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

      if (input.method !== 'WALLET') throw new Error('PAYMENT_METHOD_DISABLED');

      const walletRef = db.doc(`wallets/${userId}`);
      const walletSnap = await tx.get(walletRef);
      const currentBalance = Number(walletSnap.data()?.balance ?? 0);
      const hasFunds = currentBalance >= input.amount;
      const ledgerEntry: WalletLedgerEntry = {
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
        ...(ledgerEntry as unknown as Record<string, unknown>),
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
      auditService.logInTransaction(tx, db, {
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

export const firestoreRideRepository = new FirestoreRideRepository();
export const firestoreDispatchRepository = new FirestoreDispatchRepository();
export const firestoreWalletRepository = new FirestoreWalletRepository();
