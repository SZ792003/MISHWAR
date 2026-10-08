import assert from 'node:assert/strict';
import { FinancialTransaction, Payment } from '../../packages/shared_types/src';
import { financialOperationsService } from '../src/payments/financialOperationsService';

const now = new Date().toISOString();
const driver = { uid: 'driver_fin_01', role: 'DRIVER' as const, authSource: 'demo' as const, accountStatus: 'active' as const };
const suspendedDriver = { ...driver, uid: 'driver_suspended', accountStatus: 'suspended' as const };
const blockedDriver = { ...driver, uid: 'driver_blocked', accountStatus: 'blocked' as const };
const customer = { uid: 'cust_fin_01', role: 'CUSTOMER' as const, authSource: 'demo' as const };
const admin = { uid: 'finance_admin', role: 'FINANCE' as const, authSource: 'demo' as const };
const actor = { actorUid: 'finance_admin', actorRole: 'FINANCE' };

const basePayment: Payment = {
  id: 'pay_fin_01_wallet',
  rideId: 'ride_fin_01',
  customerId: customer.uid,
  driverId: driver.uid,
  amount: 10000,
  currency: 'YER',
  method: 'wallet',
  status: 'paid',
  idempotencyKey: 'pay_fin_01',
  createdAt: now,
  updatedAt: now,
  completedAt: now
};

const baseTransactions: FinancialTransaction[] = [
  {
    id: 'fin_payment',
    type: 'wallet_debit',
    amount: 10000,
    currency: 'YER',
    rideId: basePayment.rideId,
    paymentId: basePayment.id,
    customerId: customer.uid,
    driverId: driver.uid,
    status: 'completed',
    idempotencyKey: 'pay_fin_01',
    createdAt: now,
    completedAt: now
  },
  {
    id: 'fin_commission',
    type: 'platform_commission',
    amount: 1000,
    currency: 'YER',
    rideId: basePayment.rideId,
    paymentId: basePayment.id,
    customerId: customer.uid,
    driverId: driver.uid,
    status: 'completed',
    idempotencyKey: 'pay_fin_01:commission',
    createdAt: now,
    completedAt: now
  },
  {
    id: 'fin_earning',
    type: 'driver_earning',
    amount: 9000,
    currency: 'YER',
    rideId: basePayment.rideId,
    paymentId: basePayment.id,
    customerId: customer.uid,
    driverId: driver.uid,
    status: 'completed',
    idempotencyKey: 'pay_fin_01:driver_earning',
    createdAt: now,
    completedAt: now
  }
];

const reset = (transactions = baseTransactions, payments = [basePayment]) => {
  financialOperationsService.seedMemoryForTests({
    payments,
    transactions,
    walletBalances: [{ userId: customer.uid, balance: 0 }]
  });
};

const expectError = async (code: string, action: () => Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    assert.equal((error as Error & { code?: string }).code || (error as Error).message, code);
    return;
  }
  throw new Error(`Expected ${code}`);
};

const run = async (name: string, action: () => Promise<void>) => {
  await action();
  console.log(`PASS ${name}`);
};

await run('payout success', async () => {
  reset();
  const payout = await financialOperationsService.requestPayout({ user: driver, amount: 5000, method: 'cash_office', idempotencyKey: 'po_1', actor, usePersistentStore: false });
  assert.equal(payout.status, 'requested');
});

await run('insufficient payout balance', async () => {
  reset();
  await expectError('INSUFFICIENT_PAYOUT_BALANCE', () => financialOperationsService.requestPayout({ user: driver, amount: 20000, method: 'cash_office', idempotencyKey: 'po_2', actor, usePersistentStore: false }));
});

await run('duplicate payout idempotent', async () => {
  reset();
  const first = await financialOperationsService.requestPayout({ user: driver, amount: 4000, method: 'cash_office', idempotencyKey: 'po_dup', actor, usePersistentStore: false });
  const second = await financialOperationsService.requestPayout({ user: driver, amount: 4000, method: 'cash_office', idempotencyKey: 'po_dup', actor, usePersistentStore: false });
  assert.equal(first.id, second.id);
});

await run('reserved funds cannot be spent twice', async () => {
  reset();
  await financialOperationsService.requestPayout({ user: driver, amount: 8000, method: 'cash_office', idempotencyKey: 'po_reserve', actor, usePersistentStore: false });
  await expectError('INSUFFICIENT_PAYOUT_BALANCE', () => financialOperationsService.requestPayout({ user: driver, amount: 2000, method: 'cash_office', idempotencyKey: 'po_reserve_2', actor, usePersistentStore: false }));
});

await run('suspended driver payout rejected', async () => {
  reset();
  await expectError('DRIVER_SUSPENDED', () => financialOperationsService.requestPayout({ user: suspendedDriver, amount: 1000, method: 'cash_office', idempotencyKey: 'po_suspended', actor, usePersistentStore: false }));
});

await run('blocked driver payout rejected', async () => {
  reset();
  await expectError('DRIVER_BLOCKED', () => financialOperationsService.requestPayout({ user: blockedDriver, amount: 1000, method: 'cash_office', idempotencyKey: 'po_blocked', actor, usePersistentStore: false }));
});

await run('full refund', async () => {
  reset();
  const refund = await financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, reason: 'service_issue', idempotencyKey: 'ref_full', actor: { actorUid: customer.uid, actorRole: 'CUSTOMER' }, usePersistentStore: false });
  const completed = await financialOperationsService.approveRefund({ user: admin, refundId: refund.id, idempotencyKey: 'ref_full_approve', actor, usePersistentStore: false });
  assert.equal(completed.status, 'completed');
});

await run('partial refund', async () => {
  reset();
  const refund = await financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, amount: 3000, reason: 'service_issue', idempotencyKey: 'ref_part', actor: { actorUid: customer.uid, actorRole: 'CUSTOMER' }, usePersistentStore: false });
  assert.equal(refund.amount, 3000);
});

await run('refund greater than original rejected', async () => {
  reset();
  await expectError('REFUND_AMOUNT_EXCEEDS_REMAINING', () => financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, amount: 20000, reason: 'service_issue', idempotencyKey: 'ref_big', actor, usePersistentStore: false }));
});

await run('duplicate refund idempotent', async () => {
  reset();
  const first = await financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, amount: 1000, reason: 'service_issue', idempotencyKey: 'ref_dup', actor, usePersistentStore: false });
  const second = await financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, amount: 1000, reason: 'service_issue', idempotencyKey: 'ref_dup', actor, usePersistentStore: false });
  assert.equal(first.id, second.id);
});

await run('wallet refund atomicity', async () => {
  reset();
  const refund = await financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, amount: 2500, reason: 'service_issue', idempotencyKey: 'ref_wallet', actor, usePersistentStore: false });
  await financialOperationsService.approveRefund({ user: admin, refundId: refund.id, idempotencyKey: 'ref_wallet_approve', actor, usePersistentStore: false });
  const recon = await financialOperationsService.runFinancialReconciliation({ user: admin, actor, usePersistentStore: false });
  assert.ok(recon.checked.transactions >= 4);
});

await run('payout failure releases reservation', async () => {
  reset();
  const payout = await financialOperationsService.requestPayout({ user: driver, amount: 7000, method: 'cash_office', idempotencyKey: 'po_fail', actor, usePersistentStore: false });
  await financialOperationsService.completePayout({ user: admin, payoutId: payout.id, markFailed: true, failedReason: 'manual failure', actor, usePersistentStore: false });
  const finance = await financialOperationsService.getDriverFinance({ user: driver, usePersistentStore: false });
  assert.equal(finance.availableBalance, 9000);
});

await run('reconciliation detects missing ledger', async () => {
  reset([]);
  const recon = await financialOperationsService.runFinancialReconciliation({ user: admin, actor, usePersistentStore: false });
  assert.ok(recon.issues.some((issue) => issue.type === 'missing_internal'));
});

await run('reconciliation detects duplicate ledger', async () => {
  reset([...baseTransactions, { ...baseTransactions[2], id: 'fin_earning_dup' }]);
  const recon = await financialOperationsService.runFinancialReconciliation({ user: admin, actor, usePersistentStore: false });
  assert.ok(recon.issues.some((issue) => issue.type === 'duplicate'));
});

await run('reconciliation detects balance mismatch', async () => {
  reset();
  const recon = await financialOperationsService.runFinancialReconciliation({ user: admin, actor, usePersistentStore: false });
  assert.ok(recon.issues.some((issue) => issue.type === 'wallet_balance_mismatch'));
});

await run('settlement totals correctly', async () => {
  reset();
  const settlement = await financialOperationsService.generateSettlement({ user: admin, period: 'custom', dateFrom: '1970-01-01T00:00:00.000Z', dateTo: new Date(Date.now() + 1000).toISOString(), actor, usePersistentStore: false });
  assert.equal(settlement.grossRideAmount, 10000);
  assert.equal(settlement.platformCommission, 1000);
});

await run('unauthorized admin finance access', async () => {
  reset();
  await expectError('ADMIN_FINANCE_FORBIDDEN', () => financialOperationsService.generateSettlement({ user: customer, period: 'custom', dateFrom: '1970-01-01T00:00:00.000Z', dateTo: now, actor, usePersistentStore: false }));
});

await run('financial adjustment creates ledger entry', async () => {
  reset();
  const adjustment = await financialOperationsService.createAdjustment({ user: admin, targetUserId: driver.uid, type: 'adjustment_credit', amount: 1200, reason: 'manual correction', idempotencyKey: 'adj_1', actor, usePersistentStore: false });
  assert.ok(adjustment.transactionId);
});

await run('financial adjustment creates audit foundation', async () => {
  reset();
  const adjustment = await financialOperationsService.createAdjustment({ user: admin, targetUserId: driver.uid, type: 'adjustment_debit', amount: 500, reason: 'manual correction', idempotencyKey: 'adj_2', actor, usePersistentStore: false });
  assert.equal(adjustment.adminId, admin.uid);
});

await run('risk flag generation foundation', async () => {
  reset();
  await expectError('REFUND_AMOUNT_EXCEEDS_REMAINING', () => financialOperationsService.requestRefund({ user: customer, paymentId: basePayment.id, amount: 10001, reason: 'duplicate_charge', idempotencyKey: 'risk_refund', actor, usePersistentStore: false }));
  assert.ok(financialOperationsService.memoryRiskFlagsForTests().some((flag) => flag.type === 'duplicate_refund_attempt'));
});
