"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subtractMoney = exports.addMoney = exports.calculateCommission = exports.trustedCurrency = exports.trustedFareAmount = exports.assertMoneyAmount = exports.DEFAULT_COMMISSION_RATE = exports.DEFAULT_CURRENCY = void 0;
exports.DEFAULT_CURRENCY = 'YER';
exports.DEFAULT_COMMISSION_RATE = 0.1;
const assertMoneyAmount = (amount, code = 'INVALID_MONEY_AMOUNT') => {
    if (!Number.isInteger(amount) || Number(amount) < 0) {
        throw new Error(code);
    }
    return Number(amount);
};
exports.assertMoneyAmount = assertMoneyAmount;
const trustedFareAmount = (fare) => {
    const amount = fare?.grossFare;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
        throw new Error('TRUSTED_FARE_UNAVAILABLE');
    }
    return amount;
};
exports.trustedFareAmount = trustedFareAmount;
const trustedCurrency = (fare) => {
    return typeof fare?.currency === 'string' && fare.currency.trim() ? fare.currency : exports.DEFAULT_CURRENCY;
};
exports.trustedCurrency = trustedCurrency;
const calculateCommission = (amount, rate = exports.DEFAULT_COMMISSION_RATE) => {
    (0, exports.assertMoneyAmount)(amount);
    const boundedRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : exports.DEFAULT_COMMISSION_RATE;
    const platformCommission = Math.round(amount * boundedRate);
    return {
        platformCommission,
        driverNetEarning: amount - platformCommission
    };
};
exports.calculateCommission = calculateCommission;
const addMoney = (left, right) => {
    (0, exports.assertMoneyAmount)(left);
    (0, exports.assertMoneyAmount)(right);
    return left + right;
};
exports.addMoney = addMoney;
const subtractMoney = (left, right) => {
    (0, exports.assertMoneyAmount)(left);
    (0, exports.assertMoneyAmount)(right);
    if (right > left)
        throw new Error('NEGATIVE_BALANCE_PREVENTED');
    return left - right;
};
exports.subtractMoney = subtractMoney;
