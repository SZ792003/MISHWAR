"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.financialOperationsService = exports.FinancialOperationsService = void 0;
const auditService_1 = require("../auditService");
const auth_1 = require("../auth");
const config_1 = require("../config");
const money_1 = require("./money");
const paymentErrors_1 = require("./paymentErrors");
const paymentProvider_1 = require("./paymentProvider");
const memoryTransactions = new Map();
const memoryPayments = new Map();
const memoryPayouts = new Map();
const memoryRefunds = new Map();
const memoryIssues = new Map();
const memorySettlements = new Map();
const memoryRiskFlags = new Map();
const memoryAdjustments = new Map();
const memoryWallets = new Map();
const memoryIdempotency = new Map();
const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
const adminRoles = ['ADMIN', 'SUPER_ADMIN', 'FINANCE', 'OPS_MANAGER'];
const firestoreServerTimestamp = (firebaseAdmin) => {
    const firestoreNamespace = firebaseAdmin.admin.firestore;
    return firestoreNamespace.FieldValue?.serverTimestamp() || nowIso();
};
const idempotencyDocId = (scope, userId, key) => {
    return Buffer.from(`${scope}:${userId}:${key}`).toString('base64url');
};
const runFirestoreTransaction = async (firebaseAdmin, callback) => {
    const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
    const runTransaction = db.runTransaction;
    return runTransaction.bind(db)((tx) => callback(tx, db));
};
const assertProductionActor = (user) => {
    if ((0, config_1.isStrictBackend)() && user.authSource !== 'firebase') {
        throw new paymentErrors_1.PaymentDomainError('PRODUCTION_FINANCE_REQUIRES_FIREBASE_AUTH', 'Production finance operations require Firebase identity', 401);
    }
};
const assertAdmin = (user) => {
    if (!adminRoles.includes(user.role))
        throw new paymentErrors_1.PaymentDomainError('ADMIN_FINANCE_FORBIDDEN', 'Admin finance access is required', 403);
};
const assertDriver = (user) => {
    if (user.role !== 'DRIVER')
        throw new paymentErrors_1.PaymentDomainError('DRIVER_FINANCE_FORBIDDEN', 'Driver role is required', 403);
    if (user.accountStatus === 'suspended')
        throw new paymentErrors_1.PaymentDomainError('DRIVER_SUSPENDED', 'Suspended drivers cannot request payouts', 403);
    if (user.accountStatus === 'blocked')
        throw new paymentErrors_1.PaymentDomainError('DRIVER_BLOCKED', 'Blocked drivers cannot request payouts', 403);
};
const normalizePayoutMethod = (value) => {
    const method = String(value || 'cash_office').trim().toLowerCase();
    if (['cash_office', 'bank', 'wallet', 'digital_provider'].includes(method))
        return method;
    throw new paymentErrors_1.PaymentDomainError('INVALID_PAYOUT_METHOD', 'Unsupported payout method', 400);
};
const normalizeRefundReason = (value) => {
    const reason = String(value || 'other').trim().toLowerCase();
    if (['ride_cancelled', 'duplicate_charge', 'service_issue', 'payment_error', 'admin_adjustment', 'other'].includes(reason)) {
        return reason;
    }
    return 'other';
};
const paymentRefundedAmount = (payment) => Number(payment.refundedAmount || payment.metadata?.refundedAmount || 0);
const remainingRefundable = (payment) => payment.amount - paymentRefundedAmount(payment);
const txAmountByType = (transactions, type) => {
    return transactions.filter((item) => item.type === type && item.status === 'completed').reduce((sum, item) => sum + item.amount, 0);
};
const financeSummaryFrom = (driverId, transactions, payouts) => {
    const currency = transactions.find((item) => item.currency)?.currency || 'YER';
    const totalEarnings = txAmountByType(transactions, 'driver_earning');
    const totalPlatformCommission = txAmountByType(transactions, 'platform_commission');
    const totalPaidOut = payouts.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.amount, 0);
    const reservedBalance = payouts
        .filter((item) => ['requested', 'approved', 'processing'].includes(item.status))
        .reduce((sum, item) => sum + item.amount, 0);
    const adjustments = transactions
        .filter((item) => item.type === 'adjustment' && item.status === 'completed')
        .reduce((sum, item) => sum + (item.destination === `driver:${driverId}` ? item.amount : -item.amount), 0);
    const pendingBalance = transactions
        .filter((item) => item.type === 'driver_earning' && item.status === 'pending')
        .reduce((sum, item) => sum + item.amount, 0);
    const availableBalance = Math.max(0, totalEarnings + adjustments - totalPaidOut - reservedBalance);
    return {
        driverId,
        currency,
        availableBalance,
        pendingBalance,
        reservedBalance,
        totalEarnings,
        totalPlatformCommission,
        totalPaidOut,
        recentTransactions: transactions.slice(0, 20),
        payouts: payouts.slice(0, 20)
    };
};
class FinancialOperationsService {
    seedMemoryForTests(params) {
        memoryTransactions.clear();
        memoryPayments.clear();
        memoryPayouts.clear();
        memoryRefunds.clear();
        memoryIssues.clear();
        memorySettlements.clear();
        memoryRiskFlags.clear();
        memoryAdjustments.clear();
        memoryWallets.clear();
        memoryIdempotency.clear();
        params.payments?.forEach((payment) => memoryPayments.set(payment.id, payment));
        params.transactions?.forEach((entry) => memoryTransactions.set(entry.id, entry));
        params.payouts?.forEach((payout) => memoryPayouts.set(payout.id, payout));
        params.walletBalances?.forEach((wallet) => memoryWallets.set(wallet.userId, wallet.balance));
    }
    memoryRiskFlagsForTests() {
        return [...memoryRiskFlags.values()];
    }
    async getDriverFinance(params) {
        const driverId = params.driverId || params.user.uid;
        if (params.user.role === 'DRIVER' && driverId !== params.user.uid) {
            throw new paymentErrors_1.PaymentDomainError('DRIVER_FINANCE_FORBIDDEN', 'Drivers can only read their own finance summary', 403);
        }
        if (params.user.role !== 'DRIVER')
            assertAdmin(params.user);
        if (!params.usePersistentStore) {
            return financeSummaryFrom(driverId, [...memoryTransactions.values()].filter((item) => item.driverId === driverId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [...memoryPayouts.values()].filter((item) => item.driverId === driverId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
        }
        const firebaseAdmin = await this.adminContext();
        const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
        const [txSnap, payoutSnap] = await Promise.all([
            db.collection('financialTransactions').where('driverId', '==', driverId).get(),
            db.collection('driverPayouts').where('driverId', '==', driverId).get()
        ]);
        return financeSummaryFrom(driverId, txSnap.docs.map((doc) => doc.data()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), payoutSnap.docs.map((doc) => doc.data()).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
    }
    async requestPayout(params) {
        assertProductionActor(params.user);
        assertDriver(params.user);
        const amount = (0, money_1.assertMoneyAmount)(params.amount);
        const method = normalizePayoutMethod(params.method);
        if (amount < config_1.backendConfig.minPayoutAmount)
            throw new paymentErrors_1.PaymentDomainError('PAYOUT_BELOW_MINIMUM', 'Payout amount is below the configured minimum', 400);
        if (amount > config_1.backendConfig.maxPayoutAmount)
            throw new paymentErrors_1.PaymentDomainError('PAYOUT_ABOVE_MAXIMUM', 'Payout amount exceeds the configured maximum', 400);
        if (!params.usePersistentStore)
            return this.requestMemoryPayout({ ...params, amount, method });
        const firebaseAdmin = await this.adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('payout-request', params.user.uid, params.idempotencyKey)}`);
            const idemSnap = await tx.get(idemRef);
            if (idemSnap.exists)
                return idemSnap.data()?.response;
            const finance = await this.getDriverFinance({ user: params.user, usePersistentStore: true });
            if (amount > finance.availableBalance) {
                await this.writeRiskFlagInTx(tx, db, firebaseAdmin, {
                    type: 'rapid_payout_requests',
                    severity: 'medium',
                    driverId: params.user.uid,
                    manualReviewRequired: true,
                    metadata: { requestedAmount: amount, availableBalance: finance.availableBalance }
                });
                throw new paymentErrors_1.PaymentDomainError('INSUFFICIENT_PAYOUT_BALANCE', 'Payout amount exceeds available balance', 409);
            }
            const payout = this.buildPayout(params.user.uid, amount, finance.currency, method, params.idempotencyKey, params.requestId);
            tx.set(db.doc(`driverPayouts/${payout.id}`), { ...payout, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'payout-request', response: payout, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            auditService_1.auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'PAYOUT_REQUESTED', targetType: 'PAYOUT', targetId: payout.id, source: 'PAYMENT_BACKEND', metadata: { amount, currency: payout.currency, method } }, firestoreServerTimestamp(firebaseAdmin));
            return payout;
        });
    }
    async approvePayout(params) {
        assertAdmin(params.user);
        if (!params.usePersistentStore)
            return this.updateMemoryPayout(params.payoutId, 'approved', params.user.uid);
        const firebaseAdmin = await this.adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const payoutRef = db.doc(`driverPayouts/${params.payoutId}`);
            const payoutSnap = await tx.get(payoutRef);
            if (!payoutSnap.exists)
                throw new paymentErrors_1.PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
            const payout = payoutSnap.data();
            if (payout.status !== 'requested')
                return payout;
            const updated = { ...payout, status: 'approved', approvedAt: nowIso(), approvedBy: params.user.uid };
            tx.set(payoutRef, { ...updated, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
            auditService_1.auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'PAYOUT_APPROVED', targetType: 'PAYOUT', targetId: updated.id, source: 'PAYMENT_BACKEND', metadata: { amount: updated.amount, currency: updated.currency } }, firestoreServerTimestamp(firebaseAdmin));
            return updated;
        });
    }
    async completePayout(params) {
        assertAdmin(params.user);
        if (!params.usePersistentStore)
            return this.completeMemoryPayout(params);
        const firebaseAdmin = await this.adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const payoutRef = db.doc(`driverPayouts/${params.payoutId}`);
            const payoutSnap = await tx.get(payoutRef);
            if (!payoutSnap.exists)
                throw new paymentErrors_1.PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
            const payout = payoutSnap.data();
            if (payout.status === 'paid' || payout.status === 'failed' || payout.status === 'cancelled')
                return payout;
            const status = params.markFailed ? 'failed' : 'paid';
            const updated = {
                ...payout,
                status,
                providerReference: params.providerReference || payout.providerReference,
                payoutTransactionId: status === 'paid' ? payout.payoutTransactionId || id('fin') : payout.payoutTransactionId,
                paidAt: status === 'paid' ? nowIso() : payout.paidAt,
                failedAt: status === 'failed' ? nowIso() : payout.failedAt,
                failureReason: params.failedReason || payout.failureReason
            };
            if (status === 'paid') {
                const entry = this.buildTransaction({
                    id: updated.payoutTransactionId,
                    type: 'adjustment',
                    amount: updated.amount,
                    currency: updated.currency,
                    driverId: updated.driverId,
                    status: 'completed',
                    idempotencyKey: `${updated.id}:paid`,
                    requestId: params.requestId,
                    source: `driver:${updated.driverId}`,
                    destination: `payout:${updated.method}`,
                    metadata: { payoutId: updated.id, payoutType: 'driver_payout' }
                });
                tx.set(db.doc(`financialTransactions/${entry.id}`), { ...entry, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            }
            tx.set(payoutRef, { ...updated, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
            auditService_1.auditService.logInTransaction(tx, db, { ...params.actor, eventType: status === 'paid' ? 'PAYOUT_COMPLETED' : 'PAYOUT_FAILED', targetType: 'PAYOUT', targetId: updated.id, source: 'PAYMENT_BACKEND', metadata: { amount: updated.amount, currency: updated.currency, providerReference: updated.providerReference } }, firestoreServerTimestamp(firebaseAdmin));
            return updated;
        });
    }
    async requestRefund(params) {
        assertProductionActor(params.user);
        if (!params.usePersistentStore)
            return this.requestMemoryRefund(params);
        const firebaseAdmin = await this.adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const idemRef = db.doc(`idempotencyKeys/${idempotencyDocId('refund-request', params.user.uid, params.idempotencyKey)}`);
            const idemSnap = await tx.get(idemRef);
            if (idemSnap.exists)
                return idemSnap.data()?.response;
            const paymentSnap = await tx.get(db.doc(`payments/${params.paymentId}`));
            if (!paymentSnap.exists)
                throw new paymentErrors_1.PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
            const payment = paymentSnap.data();
            if (params.user.role === 'CUSTOMER' && payment.customerId !== params.user.uid) {
                throw new paymentErrors_1.PaymentDomainError('REFUND_FORBIDDEN', 'Customer can only refund own payments', 403);
            }
            if (params.user.role !== 'CUSTOMER')
                assertAdmin(params.user);
            if (payment.status !== 'paid' && payment.status !== 'partially_refunded')
                throw new paymentErrors_1.PaymentDomainError('PAYMENT_NOT_REFUNDABLE', 'Payment is not refundable', 409);
            const amount = (0, money_1.assertMoneyAmount)(params.amount ?? remainingRefundable(payment));
            if (amount > config_1.backendConfig.maxRefundAmount)
                throw new paymentErrors_1.PaymentDomainError('REFUND_ABOVE_MAXIMUM', 'Refund amount exceeds configured maximum', 400);
            if (amount > remainingRefundable(payment)) {
                await this.writeRiskFlagInTx(tx, db, firebaseAdmin, { type: 'duplicate_refund_attempt', severity: 'high', userId: params.user.uid, paymentId: payment.id, manualReviewRequired: true, metadata: { requestedAmount: amount, remainingRefundableAmount: remainingRefundable(payment) } });
                throw new paymentErrors_1.PaymentDomainError('REFUND_AMOUNT_EXCEEDS_REMAINING', 'Refund amount exceeds remaining refundable amount', 409);
            }
            const refund = this.buildRefund(payment, amount, normalizeRefundReason(params.reason), params.user.uid, params.idempotencyKey, params.requestId);
            tx.set(db.doc(`refunds/${refund.id}`), { ...refund, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            tx.set(idemRef, { key: params.idempotencyKey, userId: params.user.uid, scope: 'refund-request', response: refund, createdAt: nowIso(), serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            auditService_1.auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'REFUND_REQUESTED', targetType: 'REFUND', targetId: refund.id, rideId: refund.rideId, source: 'PAYMENT_BACKEND', metadata: { paymentId: refund.paymentId, amount: refund.amount, currency: refund.currency, reason: refund.reason } }, firestoreServerTimestamp(firebaseAdmin));
            return refund;
        });
    }
    async approveRefund(params) {
        assertAdmin(params.user);
        if (!params.usePersistentStore)
            return this.approveMemoryRefund(params);
        const firebaseAdmin = await this.adminContext();
        return runFirestoreTransaction(firebaseAdmin, async (tx, db) => {
            const refundRef = db.doc(`refunds/${params.refundId}`);
            const refundSnap = await tx.get(refundRef);
            if (!refundSnap.exists)
                throw new paymentErrors_1.PaymentDomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
            const refund = refundSnap.data();
            if (refund.status === 'completed')
                return refund;
            const paymentSnap = await tx.get(db.doc(`payments/${refund.paymentId}`));
            if (!paymentSnap.exists)
                throw new paymentErrors_1.PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
            const payment = paymentSnap.data();
            if (refund.amount > remainingRefundable(payment))
                throw new paymentErrors_1.PaymentDomainError('REFUND_AMOUNT_EXCEEDS_REMAINING', 'Refund amount exceeds remaining refundable amount', 409);
            if (payment.method === 'digital_provider') {
                await paymentProvider_1.paymentProvider.refundPayment({
                    paymentId: payment.id,
                    refundId: refund.id,
                    providerTransactionId: payment.providerTransactionId,
                    amount: refund.amount,
                    currency: refund.currency,
                    idempotencyKey: params.idempotencyKey,
                    requestId: params.requestId
                });
            }
            const completed = this.completeRefundObjects(payment, refund, params.user.uid, params.requestId);
            tx.set(refundRef, { ...completed.refund, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
            tx.set(db.doc(`payments/${payment.id}`), { ...completed.payment, serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
            tx.set(db.doc(`financialTransactions/${completed.transaction.id}`), { ...completed.transaction, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            if (payment.method === 'wallet') {
                const walletRef = db.doc(`wallets/${payment.customerId}`);
                const walletSnap = await tx.get(walletRef);
                const balanceBefore = Number(walletSnap.data()?.balance ?? 0);
                const balanceAfter = (0, money_1.addMoney)(balanceBefore, refund.amount);
                tx.set(walletRef, { userId: payment.customerId, balance: balanceAfter, updatedAt: nowIso(), serverUpdatedAt: firestoreServerTimestamp(firebaseAdmin) }, { merge: true });
                tx.set(db.doc(`walletTransactions/${completed.transaction.id}`), {
                    transactionId: completed.transaction.id,
                    userId: payment.customerId,
                    type: 'REFUND',
                    amount: refund.amount,
                    balanceBefore,
                    balanceAfter,
                    status: 'SUCCESS',
                    createdAt: completed.transaction.createdAt,
                    referenceId: refund.id,
                    idempotencyKey: refund.idempotencyKey,
                    serverCreatedAt: firestoreServerTimestamp(firebaseAdmin)
                });
            }
            auditService_1.auditService.logInTransaction(tx, db, { ...params.actor, eventType: 'REFUND_COMPLETED', targetType: 'REFUND', targetId: refund.id, rideId: refund.rideId, source: 'PAYMENT_BACKEND', metadata: { paymentId: refund.paymentId, amount: refund.amount, currency: refund.currency } }, firestoreServerTimestamp(firebaseAdmin));
            return completed.refund;
        });
    }
    async runFinancialReconciliation(params) {
        assertAdmin(params.user);
        const data = params.usePersistentStore ? await this.readPersistentFinanceData() : this.readMemoryFinanceData();
        const payments = data.payments.filter((payment) => (!params.paymentId || payment.id === params.paymentId) &&
            (!params.driverId || payment.driverId === params.driverId) &&
            (!params.dateFrom || payment.createdAt >= params.dateFrom) &&
            (!params.dateTo || payment.createdAt <= params.dateTo));
        const transactions = data.transactions.filter((entry) => (!params.driverId || entry.driverId === params.driverId) &&
            (!params.dateFrom || entry.createdAt >= params.dateFrom) &&
            (!params.dateTo || entry.createdAt <= params.dateTo));
        const issues = this.detectIssues(payments, transactions, data.walletBalances);
        if (params.usePersistentStore)
            await this.persistReconciliationIssues(params, issues);
        else
            issues.forEach((issue) => memoryIssues.set(issue.id, issue));
        return { status: issues.length === 0 ? 'matched' : 'manual_review', issues, checked: { payments: payments.length, transactions: transactions.length } };
    }
    async generateSettlement(params) {
        assertAdmin(params.user);
        const data = params.usePersistentStore ? await this.readPersistentFinanceData() : this.readMemoryFinanceData();
        const payments = data.payments.filter((payment) => payment.createdAt >= params.dateFrom &&
            payment.createdAt <= params.dateTo &&
            (!params.driverId || payment.driverId === params.driverId));
        const transactions = data.transactions.filter((entry) => entry.createdAt >= params.dateFrom &&
            entry.createdAt <= params.dateTo &&
            (!params.driverId || entry.driverId === params.driverId));
        const payouts = data.payouts.filter((payout) => payout.requestedAt >= params.dateFrom &&
            payout.requestedAt <= params.dateTo &&
            (!params.driverId || payout.driverId === params.driverId));
        const report = {
            id: id('settlement'),
            period: params.period,
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
            driverId: params.driverId,
            currency: payments[0]?.currency || transactions[0]?.currency || 'YER',
            grossRideAmount: payments.filter((p) => p.status === 'paid' || p.status === 'partially_refunded' || p.status === 'refunded').reduce((sum, p) => sum + p.amount, 0),
            cashCollected: payments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0),
            walletCollected: payments.filter((p) => p.method === 'wallet').reduce((sum, p) => sum + p.amount, 0),
            digitalCollected: payments.filter((p) => p.method === 'digital_provider').reduce((sum, p) => sum + p.amount, 0),
            driverGrossEarnings: txAmountByType(transactions, 'driver_earning'),
            platformCommission: txAmountByType(transactions, 'platform_commission'),
            refunds: txAmountByType(transactions, 'refund'),
            payouts: payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0),
            adjustments: txAmountByType(transactions, 'adjustment'),
            netSettlement: 0,
            status: 'generated',
            generatedAt: nowIso(),
            generatedBy: params.user.uid,
            requestId: params.requestId
        };
        report.netSettlement = report.grossRideAmount - report.platformCommission - report.refunds - report.payouts + report.adjustments;
        if (params.usePersistentStore) {
            const firebaseAdmin = await this.adminContext();
            const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
            await db.doc(`settlements/${report.id}`).set({ ...report, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            await auditService_1.auditService.log({ ...params.actor, eventType: 'SETTLEMENT_GENERATED', targetType: 'SETTLEMENT', targetId: report.id, source: 'PAYMENT_BACKEND', metadata: { netSettlement: report.netSettlement, currency: report.currency } });
        }
        else {
            memorySettlements.set(report.id, report);
        }
        return report;
    }
    async createAdjustment(params) {
        assertAdmin(params.user);
        const amount = (0, money_1.assertMoneyAmount)(params.amount);
        if (!params.reason || params.reason.trim().length < 4)
            throw new paymentErrors_1.PaymentDomainError('ADJUSTMENT_REASON_REQUIRED', 'Adjustment reason is required', 400);
        const transaction = this.buildTransaction({
            type: 'adjustment',
            amount,
            currency: 'YER',
            driverId: params.targetUserId,
            status: 'completed',
            idempotencyKey: params.idempotencyKey,
            requestId: params.requestId,
            source: params.type === 'adjustment_credit' ? 'mishwar_platform' : `driver:${params.targetUserId}`,
            destination: params.type === 'adjustment_credit' ? `driver:${params.targetUserId}` : 'mishwar_platform',
            metadata: { adjustmentType: params.type, reason: params.reason }
        });
        const adjustment = {
            id: id('adjustment'),
            type: params.type,
            userId: params.targetUserId,
            amount,
            currency: transaction.currency,
            reason: params.reason,
            adminId: params.user.uid,
            requestId: params.requestId,
            transactionId: transaction.id,
            createdAt: transaction.createdAt
        };
        if (params.usePersistentStore) {
            const firebaseAdmin = await this.adminContext();
            const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
            await db.doc(`financialTransactions/${transaction.id}`).set({ ...transaction, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            await db.doc(`financialAdjustments/${adjustment.id}`).set({ ...adjustment, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
            await auditService_1.auditService.log({ ...params.actor, eventType: 'FINANCIAL_ADJUSTMENT_CREATED', targetType: 'WALLET', targetId: params.targetUserId, source: 'PAYMENT_BACKEND', metadata: { adjustmentId: adjustment.id, transactionId: transaction.id, amount, currency: transaction.currency } });
        }
        else {
            memoryTransactions.set(transaction.id, transaction);
            memoryAdjustments.set(adjustment.id, adjustment);
        }
        return adjustment;
    }
    requestMemoryPayout(params) {
        if (memoryIdempotency.has(params.idempotencyKey))
            return memoryIdempotency.get(params.idempotencyKey);
        const finance = financeSummaryFrom(params.user.uid, [...memoryTransactions.values()].filter((item) => item.driverId === params.user.uid), [...memoryPayouts.values()].filter((item) => item.driverId === params.user.uid));
        if (params.amount > finance.availableBalance)
            throw new paymentErrors_1.PaymentDomainError('INSUFFICIENT_PAYOUT_BALANCE', 'Payout amount exceeds available balance', 409);
        const payout = this.buildPayout(params.user.uid, params.amount, finance.currency, params.method, params.idempotencyKey, params.requestId);
        memoryPayouts.set(payout.id, payout);
        memoryIdempotency.set(params.idempotencyKey, payout);
        return payout;
    }
    updateMemoryPayout(payoutId, status, adminId) {
        const payout = memoryPayouts.get(payoutId);
        if (!payout)
            throw new paymentErrors_1.PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
        const updated = { ...payout, status, approvedAt: nowIso(), approvedBy: adminId };
        memoryPayouts.set(updated.id, updated);
        return updated;
    }
    completeMemoryPayout(params) {
        const payout = memoryPayouts.get(params.payoutId);
        if (!payout)
            throw new paymentErrors_1.PaymentDomainError('PAYOUT_NOT_FOUND', 'Payout not found', 404);
        const updated = { ...payout, status: params.markFailed ? 'failed' : 'paid', paidAt: params.markFailed ? undefined : nowIso(), failedAt: params.markFailed ? nowIso() : undefined, failureReason: params.failedReason, providerReference: params.providerReference };
        memoryPayouts.set(updated.id, updated);
        if (!params.markFailed) {
            const entry = this.buildTransaction({ type: 'adjustment', amount: updated.amount, currency: updated.currency, driverId: updated.driverId, status: 'completed', idempotencyKey: `${updated.id}:paid`, source: `driver:${updated.driverId}`, destination: `payout:${updated.method}`, metadata: { payoutId: updated.id, payoutType: 'driver_payout' } });
            memoryTransactions.set(entry.id, entry);
        }
        return updated;
    }
    requestMemoryRefund(params) {
        if (memoryIdempotency.has(params.idempotencyKey))
            return memoryIdempotency.get(params.idempotencyKey);
        const payment = memoryPayments.get(params.paymentId);
        if (!payment)
            throw new paymentErrors_1.PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
        if (payment.customerId !== params.user.uid && !adminRoles.includes(params.user.role))
            throw new paymentErrors_1.PaymentDomainError('REFUND_FORBIDDEN', 'Refund forbidden', 403);
        const amount = (0, money_1.assertMoneyAmount)(params.amount ?? remainingRefundable(payment));
        if (amount > remainingRefundable(payment)) {
            const flagId = id('risk');
            memoryRiskFlags.set(flagId, {
                id: flagId,
                type: 'duplicate_refund_attempt',
                severity: 'high',
                userId: params.user.uid,
                paymentId: payment.id,
                createdAt: nowIso(),
                manualReviewRequired: true,
                metadata: { requestedAmount: amount, remainingRefundableAmount: remainingRefundable(payment) }
            });
            throw new paymentErrors_1.PaymentDomainError('REFUND_AMOUNT_EXCEEDS_REMAINING', 'Refund amount exceeds remaining refundable amount', 409);
        }
        const refund = this.buildRefund(payment, amount, normalizeRefundReason(params.reason), params.user.uid, params.idempotencyKey, params.requestId);
        memoryRefunds.set(refund.id, refund);
        memoryIdempotency.set(params.idempotencyKey, refund);
        return refund;
    }
    approveMemoryRefund(params) {
        const refund = memoryRefunds.get(params.refundId);
        if (!refund)
            throw new paymentErrors_1.PaymentDomainError('REFUND_NOT_FOUND', 'Refund not found', 404);
        const payment = memoryPayments.get(refund.paymentId);
        if (!payment)
            throw new paymentErrors_1.PaymentDomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
        const completed = this.completeRefundObjects(payment, refund, params.user.uid, params.requestId);
        memoryPayments.set(payment.id, completed.payment);
        memoryRefunds.set(refund.id, completed.refund);
        memoryTransactions.set(completed.transaction.id, completed.transaction);
        if (payment.method === 'wallet')
            memoryWallets.set(payment.customerId, (0, money_1.addMoney)(memoryWallets.get(payment.customerId) || 0, refund.amount));
        return completed.refund;
    }
    buildPayout(driverId, amount, currency, method, idempotencyKey, requestId) {
        return { id: id('payout'), driverId, amount, currency, method, status: 'requested', idempotencyKey, requestId, requestedAt: nowIso() };
    }
    buildRefund(payment, amount, reason, requestedBy, idempotencyKey, requestId) {
        return { id: id('refund'), paymentId: payment.id, rideId: payment.rideId, customerId: payment.customerId, driverId: payment.driverId, amount, currency: payment.currency, reason, status: 'requested', idempotencyKey, requestId, requestedBy, createdAt: nowIso() };
    }
    completeRefundObjects(payment, refund, approvedBy, requestId) {
        const refundedAmount = (0, money_1.addMoney)(paymentRefundedAmount(payment), refund.amount);
        const updatedPayment = { ...payment, refundedAmount, status: refundedAmount >= payment.amount ? 'refunded' : 'partially_refunded', updatedAt: nowIso(), metadata: { ...payment.metadata, refundedAmount } };
        const updatedRefund = { ...refund, status: 'completed', approvedBy, approvedAt: nowIso(), completedAt: nowIso(), refundTransactionId: refund.refundTransactionId || id('fin') };
        const transaction = this.buildTransaction({
            id: updatedRefund.refundTransactionId,
            type: 'refund',
            amount: refund.amount,
            currency: refund.currency,
            rideId: refund.rideId,
            paymentId: refund.paymentId,
            customerId: refund.customerId,
            driverId: refund.driverId,
            status: 'completed',
            idempotencyKey: refund.idempotencyKey,
            requestId,
            source: 'mishwar_platform',
            destination: `customer:${refund.customerId}`,
            metadata: { refundId: refund.id, reason: refund.reason }
        });
        return { payment: updatedPayment, refund: updatedRefund, transaction };
    }
    buildTransaction(input) {
        return { ...input, id: input.id || id('fin'), createdAt: nowIso(), completedAt: input.status === 'completed' ? nowIso() : undefined };
    }
    detectIssues(payments, transactions, walletBalances) {
        const issues = [];
        const txByPayment = new Map();
        for (const entry of transactions) {
            if (entry.paymentId)
                txByPayment.set(entry.paymentId, [...(txByPayment.get(entry.paymentId) || []), entry]);
        }
        for (const payment of payments) {
            if (payment.status === 'paid' && !(txByPayment.get(payment.id) || []).some((entry) => ['ride_payment', 'wallet_debit'].includes(entry.type) && entry.status === 'completed')) {
                issues.push(this.issue('missing_internal', 'critical', { paymentId: payment.id, expectedAmount: payment.amount, currency: payment.currency }));
            }
            const commission = txAmountByType(txByPayment.get(payment.id) || [], 'platform_commission');
            const earning = txAmountByType(txByPayment.get(payment.id) || [], 'driver_earning');
            if (payment.status === 'paid' && commission + earning !== payment.amount) {
                issues.push(this.issue('mismatch', 'high', { paymentId: payment.id, expectedAmount: payment.amount, actualAmount: commission + earning, currency: payment.currency }));
            }
        }
        const idempotencyCounts = new Map();
        transactions.forEach((entry) => idempotencyCounts.set(entry.idempotencyKey, [...(idempotencyCounts.get(entry.idempotencyKey) || []), entry]));
        for (const entries of idempotencyCounts.values()) {
            if (entries.length > 1)
                issues.push(this.issue('duplicate', 'high', { transactionId: entries[0].id, actualAmount: entries.reduce((sum, item) => sum + item.amount, 0), currency: entries[0].currency }));
        }
        for (const [userId, balance] of walletBalances.entries()) {
            const ledgerBalance = transactions
                .filter((entry) => entry.customerId === userId && ['wallet_credit', 'refund', 'adjustment'].includes(entry.type) && entry.status === 'completed')
                .reduce((sum, entry) => sum + entry.amount, 0) -
                transactions
                    .filter((entry) => entry.customerId === userId && entry.type === 'wallet_debit' && entry.status === 'completed')
                    .reduce((sum, entry) => sum + entry.amount, 0);
            if (ledgerBalance !== balance) {
                issues.push(this.issue('wallet_balance_mismatch', 'high', { expectedAmount: ledgerBalance, actualAmount: balance, currency: 'YER', metadata: { userId } }));
            }
        }
        return issues;
    }
    issue(type, severity, data) {
        return { id: id('recon_issue'), type, severity, status: 'open', createdAt: nowIso(), ...data };
    }
    async persistReconciliationIssues(params, issues) {
        const firebaseAdmin = await this.adminContext();
        const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
        await auditService_1.auditService.log({ ...params.actor, eventType: 'RECONCILIATION_STARTED', targetType: 'RECONCILIATION', targetId: params.requestId || id('recon'), source: 'PAYMENT_BACKEND', metadata: { issueCount: issues.length } });
        await Promise.all(issues.map((issue) => db.doc(`reconciliationIssues/${issue.id}`).set({ ...issue, requestId: params.requestId, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) })));
        if (issues.length > 0) {
            await auditService_1.auditService.log({ ...params.actor, eventType: 'RECONCILIATION_MISMATCH_DETECTED', targetType: 'RECONCILIATION', targetId: params.requestId || id('recon'), source: 'PAYMENT_BACKEND', metadata: { issueCount: issues.length } });
        }
        await auditService_1.auditService.log({ ...params.actor, eventType: 'RECONCILIATION_COMPLETED', targetType: 'RECONCILIATION', targetId: params.requestId || id('recon'), source: 'PAYMENT_BACKEND', metadata: { issueCount: issues.length } });
    }
    async writeRiskFlagInTx(tx, db, firebaseAdmin, input) {
        const flag = { ...input, id: id('risk'), createdAt: nowIso() };
        tx.set(db.doc(`financialRiskFlags/${flag.id}`), { ...flag, serverCreatedAt: firestoreServerTimestamp(firebaseAdmin) });
    }
    readMemoryFinanceData() {
        return { payments: [...memoryPayments.values()], transactions: [...memoryTransactions.values()], payouts: [...memoryPayouts.values()], walletBalances: new Map(memoryWallets) };
    }
    async readPersistentFinanceData() {
        const firebaseAdmin = await this.adminContext();
        const db = firebaseAdmin.admin.firestore(firebaseAdmin.app);
        const [paymentsSnap, txSnap, payoutSnap, walletsSnap] = await Promise.all([
            db.collection('payments').get(),
            db.collection('financialTransactions').get(),
            db.collection('driverPayouts').get(),
            db.collection('wallets').get()
        ]);
        const walletBalances = new Map();
        walletsSnap.docs.forEach((doc) => walletBalances.set(String(doc.data().userId || doc.id), Number(doc.data().balance || 0)));
        return {
            payments: paymentsSnap.docs.map((doc) => doc.data()),
            transactions: txSnap.docs.map((doc) => doc.data()),
            payouts: payoutSnap.docs.map((doc) => doc.data()),
            walletBalances
        };
    }
    async adminContext() {
        const firebaseAdmin = await (0, auth_1.getFirebaseAdmin)();
        if (!firebaseAdmin)
            throw new paymentErrors_1.PaymentDomainError('DATABASE_UNAVAILABLE', 'Persistent database is unavailable', 503);
        return firebaseAdmin;
    }
}
exports.FinancialOperationsService = FinancialOperationsService;
exports.financialOperationsService = new FinancialOperationsService();
