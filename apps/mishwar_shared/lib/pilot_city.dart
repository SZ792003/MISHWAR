import 'package:mishwar_shared/geo_models.dart';

const pilotCityNameAr = 'عدن';
const pilotCityNameEn = 'Aden';
const pilotCountryCode = 'YE';
const pilotCurrency = 'YER';
const pilotTimezone = 'Asia/Aden';

const pilotCityCenterLatitude = 12.7855;
const pilotCityCenterLongitude = 45.0187;

const pilotCityCenter = GeoPointModel(
  latitude: pilotCityCenterLatitude,
  longitude: pilotCityCenterLongitude,
);

const pilotDefaultPickupName = 'مركز عدن التجريبي';
const pilotDefaultDestinationName = 'المنصورة';
const pilotDefaultPickupLatitude = pilotCityCenterLatitude;
const pilotDefaultPickupLongitude = pilotCityCenterLongitude;
const pilotDefaultDestinationLatitude = 12.8531;
const pilotDefaultDestinationLongitude = 44.9717;
