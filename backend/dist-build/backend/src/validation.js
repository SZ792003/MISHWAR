"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertPositiveAmount = exports.assertPaymentMethod = exports.assertPassengerCount = exports.assertVehicleType = exports.assertGeoPoint = exports.ApiValidationError = void 0;
class ApiValidationError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}
exports.ApiValidationError = ApiValidationError;
const assertGeoPoint = (value, fieldName) => {
    const point = value;
    if (!point ||
        typeof point.latitude !== 'number' ||
        typeof point.longitude !== 'number' ||
        !Number.isFinite(point.latitude) ||
        !Number.isFinite(point.longitude) ||
        point.latitude < -90 ||
        point.latitude > 90 ||
        point.longitude < -180 ||
        point.longitude > 180) {
        throw new ApiValidationError('INVALID_COORDINATES', `${fieldName} coordinates are invalid`, { fieldName });
    }
    return {
        latitude: point.latitude,
        longitude: point.longitude,
        addressName: typeof point.addressName === 'string' ? point.addressName : fieldName
    };
};
exports.assertGeoPoint = assertGeoPoint;
const assertVehicleType = (value) => {
    const allowed = ['MOTORCYCLE', 'ECONOMY', 'COMFORT', 'FAMILY', 'CAR'];
    if (!allowed.includes(value)) {
        throw new ApiValidationError('INVALID_VEHICLE_TYPE', 'Vehicle type is invalid', { allowed });
    }
    return value;
};
exports.assertVehicleType = assertVehicleType;
const assertPassengerCount = (value) => {
    const count = Number(value ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 6) {
        throw new ApiValidationError('INVALID_PASSENGER_COUNT', 'Passenger count must be between 1 and 6', { count });
    }
    return count;
};
exports.assertPassengerCount = assertPassengerCount;
const assertPaymentMethod = (value) => {
    const allowed = ['CASH', 'WALLET', 'CARD', 'DIGITAL_PROVIDER'];
    if (!allowed.includes(value)) {
        throw new ApiValidationError('INVALID_PAYMENT_METHOD', 'Payment method is invalid', { allowed });
    }
    return value;
};
exports.assertPaymentMethod = assertPaymentMethod;
const assertPositiveAmount = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new ApiValidationError('INVALID_PAYMENT_AMOUNT', 'Payment amount must be greater than zero', { amount });
    }
    return amount;
};
exports.assertPositiveAmount = assertPositiveAmount;
