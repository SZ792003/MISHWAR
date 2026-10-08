import { FareCalculation } from '../../../packages/shared_types/src';

export const DEFAULT_CURRENCY = 'YER';
export const DEFAULT_COMMISSION_RATE = 0.1;

export type MoneyInput = {
  amount: number;
  currency?: string;
};

export const assertMoneyAmount = (amount: unknown, code = 'INVALID_MONEY_AMOUNT'): number => {
  if (!Number.isInteger(amount) || Number(amount) < 0) {
    throw new Error(code);
  }
  return Number(amount);
};

export const trustedFareAmount = (fare: FareCalculation | undefined | null): number => {
  const amount = fare?.grossFare;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('TRUSTED_FARE_UNAVAILABLE');
  }
  return amount;
};

export const trustedCurrency = (fare: FareCalculation | undefined | null): string => {
  return typeof fare?.currency === 'string' && fare.currency.trim() ? fare.currency : DEFAULT_CURRENCY;
};

export const calculateCommission = (
  amount: number,
  rate = DEFAULT_COMMISSION_RATE
): { platformCommission: number; driverNetEarning: number } => {
  assertMoneyAmount(amount);
  const boundedRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_COMMISSION_RATE;
  const platformCommission = Math.round(amount * boundedRate);
  return {
    platformCommission,
    driverNetEarning: amount - platformCommission
  };
};

export const addMoney = (left: number, right: number): number => {
  assertMoneyAmount(left);
  assertMoneyAmount(right);
  return left + right;
};

export const subtractMoney = (left: number, right: number): number => {
  assertMoneyAmount(left);
  assertMoneyAmount(right);
  if (right > left) throw new Error('NEGATIVE_BALANCE_PREVENTED');
  return left - right;
};
