enum MishwarLocationUiState {
  idle,
  waitingForGps,
  permissionDenied,
  permissionDeniedForever,
  serviceDisabled,
  ready,
  failed,
}

String locationUiMessage(MishwarLocationUiState state) => switch (state) {
  MishwarLocationUiState.waitingForGps => 'جارٍ تحديد موقعك عبر GPS...',
  MishwarLocationUiState.permissionDenied =>
    'لم يتم منح إذن الموقع. يمكنك اختيار النقطة يدوياً من الخريطة.',
  MishwarLocationUiState.permissionDeniedForever =>
    'إذن الموقع محظور. غيّره من إعدادات الجهاز ثم حاول مجدداً.',
  MishwarLocationUiState.serviceDisabled =>
    'فعّل خدمة الموقع على جهازك ثم حاول مجدداً.',
  MishwarLocationUiState.ready => 'تم تحديد الموقع بنجاح.',
  MishwarLocationUiState.failed =>
    'تعذر تحديد الموقع الحالي. يمكنك اختيار النقطة يدوياً.',
  MishwarLocationUiState.idle => 'يمكنك استخدام GPS أو اختيار النقطة يدوياً.',
};
