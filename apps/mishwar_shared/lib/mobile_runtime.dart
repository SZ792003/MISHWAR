import 'dart:async';
import 'dart:ui';

import 'package:firebase_analytics/firebase_analytics.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mishwar_shared/mishwar_api.dart';
import 'package:mishwar_shared/mishwar_brand.dart';

Future<bool> ensureFirebaseReady() async {
  try {
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp();
    }
    return true;
  } catch (_) {
    return false;
  }
}

Future<String?> firebaseIdToken() async {
  if (!await ensureFirebaseReady()) return null;
  return FirebaseAuth.instance.currentUser?.getIdToken();
}

@pragma('vm:entry-point')
Future<void> mishwarFirebaseMessagingBackgroundHandler(
    RemoteMessage message) async {
  await ensureFirebaseReady();
  await recordNonFatal(
    'background_push_received',
    error: 'messageId:${message.messageId ?? 'unknown'}',
  );
}

String _notificationAppName(String role) =>
    role == 'DRIVER' ? 'driver' : 'customer';

Future<void> setupFirebaseRuntime({
  required String role,
}) async {
  if (mishwarAppMode.toLowerCase() == 'demo') return;
  if (!await ensureFirebaseReady()) return;
  try {
    FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
    PlatformDispatcher.instance.onError = (error, stack) {
      FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
      return true;
    };
    await FirebaseCrashlytics.instance
        .setCustomKey('app_role', _notificationAppName(role));
    await FirebaseCrashlytics.instance.setCustomKey('app_mode', mishwarAppMode);
    await FirebaseMessaging.instance
        .setForegroundNotificationPresentationOptions(
      alert: true,
      badge: true,
      sound: true,
    );
    FirebaseMessaging.onBackgroundMessage(
        mishwarFirebaseMessagingBackgroundHandler);
    FirebaseMessaging.onMessage.listen((message) {
      unawaited(logAnalyticsEvent(
        role: role,
        name: 'push_foreground_received',
        parameters: _safePushParameters(message),
      ));
    });
    FirebaseMessaging.onMessageOpenedApp.listen((message) {
      unawaited(logAnalyticsEvent(
        role: role,
        name: 'push_opened',
        parameters: _safePushParameters(message),
      ));
    });
    final initialMessage = await FirebaseMessaging.instance.getInitialMessage();
    if (initialMessage != null) {
      await logAnalyticsEvent(
        role: role,
        name: 'push_opened',
        parameters: _safePushParameters(initialMessage),
      );
    }
    await logAnalyticsEvent(role: role, name: 'app_open');
  } catch (error, stack) {
    await recordNonFatal('firebase_runtime_setup_failed',
        error: error, stack: stack);
  }
}

Future<void> registerMessagingToken({
  required MishwarApi api,
  required String role,
}) async {
  if (mishwarAppMode.toLowerCase() == 'demo') return;
  if (!await ensureFirebaseReady()) return;
  try {
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission(alert: true, badge: true, sound: true);
    final token = await messaging.getToken();
    if (token == null || token.isEmpty) return;
    await api.registerDeviceToken(
      role: role,
      token: token,
      platform: defaultTargetPlatform.name,
    );
    FirebaseMessaging.instance.onTokenRefresh.listen((refreshedToken) {
      if (refreshedToken.isEmpty) return;
      unawaited(api.registerDeviceToken(
        role: role,
        token: refreshedToken,
        platform: defaultTargetPlatform.name,
      ));
    });
  } catch (_) {
    // Push registration should never block the ride flow.
  }
}

Future<void> unregisterMessagingToken({
  required MishwarApi api,
  required String role,
}) async {
  if (mishwarAppMode.toLowerCase() == 'demo') return;
  if (!await ensureFirebaseReady()) return;
  try {
    final token = await FirebaseMessaging.instance.getToken();
    if (token == null || token.isEmpty) return;
    await api.unregisterDeviceToken(role: role, token: token);
  } catch (_) {
    // Logout should continue even if token cleanup is unavailable.
  }
}

Future<void> signOutAndClearSession({
  required MishwarApi api,
  required String role,
}) async {
  await unregisterMessagingToken(api: api, role: role);
  await api.clearLocalSessionData();
  if (!await ensureFirebaseReady()) return;
  await FirebaseAuth.instance.signOut();
}

Map<String, Object> _safePushParameters(RemoteMessage message) {
  return {
    if (message.data['event'] is String)
      'event': message.data['event'] as String,
    if (message.data['status'] is String)
      'status': message.data['status'] as String,
    if (message.data['rideId'] is String) 'ride_id_present': true,
  };
}

Future<void> logAnalyticsEvent({
  required String role,
  required String name,
  Map<String, Object?> parameters = const {},
}) async {
  if (mishwarAppMode.toLowerCase() == 'demo') return;
  if (!await ensureFirebaseReady()) return;
  final safeParameters = <String, Object>{
    'app_role': _notificationAppName(role),
    'app_mode': mishwarAppMode,
  };
  for (final entry in parameters.entries) {
    final key = entry.key.toLowerCase();
    if (key.contains('phone') ||
        key.contains('name') ||
        key.contains('coordinate') ||
        key.contains('location') ||
        key.contains('token') ||
        key.contains('payment') ||
        key.contains('wallet') ||
        key.contains('kyc')) {
      continue;
    }
    final value = entry.value;
    if (value is String || value is num || value is bool) {
      safeParameters[entry.key] = value as Object;
    }
  }
  try {
    await FirebaseAnalytics.instance
        .logEvent(name: name, parameters: safeParameters);
  } catch (error, stack) {
    await recordNonFatal('analytics_event_failed', error: error, stack: stack);
  }
}

Future<void> recordNonFatal(
  String reason, {
  Object? error,
  StackTrace? stack,
}) async {
  if (mishwarAppMode.toLowerCase() == 'demo') return;
  if (!await ensureFirebaseReady()) return;
  try {
    await FirebaseCrashlytics.instance.recordError(
      error ?? reason,
      stack,
      reason: reason,
      fatal: false,
    );
  } catch (_) {
    // Diagnostics must never break the user flow.
  }
}

class AuthGate extends StatefulWidget {
  const AuthGate({
    super.key,
    required this.role,
    required this.child,
  });

  final String role;
  final Widget child;

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late Future<bool> _firebaseReady;

  @override
  void initState() {
    super.initState();
    _firebaseReady = ensureFirebaseReady();
  }

  @override
  Widget build(BuildContext context) {
    if (mishwarAppMode.toLowerCase() == 'demo') return widget.child;

    return FutureBuilder<bool>(
      future: _firebaseReady,
      builder: (context, readySnapshot) {
        if (readySnapshot.connectionState != ConnectionState.done) {
          return const _AuthScaffold(
              child: Center(child: CircularProgressIndicator()));
        }
        if (readySnapshot.data != true) {
          return const _AuthScaffold(
            child: _AuthMessage(
              title: 'Firebase غير مهيأ',
              message:
                  'أضف إعدادات Firebase للتطبيق ثم أعد التشغيل لتفعيل تسجيل الدخول الحقيقي.',
            ),
          );
        }

        return StreamBuilder<User?>(
          stream: FirebaseAuth.instance.authStateChanges(),
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const _AuthScaffold(
                  child: Center(child: CircularProgressIndicator()));
            }
            if (snapshot.data == null) return PhoneOtpSignIn(role: widget.role);
            return widget.child;
          },
        );
      },
    );
  }
}

class PhoneOtpSignIn extends StatefulWidget {
  const PhoneOtpSignIn({super.key, required this.role});

  final String role;

  @override
  State<PhoneOtpSignIn> createState() => _PhoneOtpSignInState();
}

class _PhoneOtpSignInState extends State<PhoneOtpSignIn> {
  final _phoneController = TextEditingController(text: '+967');
  final _codeController = TextEditingController();
  String? _verificationId;
  String? _message;
  bool _busy = false;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: _phoneController.text.trim(),
        verificationCompleted: (credential) async {
          await FirebaseAuth.instance.signInWithCredential(credential);
        },
        verificationFailed: (error) {
          if (mounted)
            setState(() => _message = error.message ?? 'تعذر إرسال رمز التحقق');
        },
        codeSent: (verificationId, _) {
          if (mounted) {
            setState(() {
              _verificationId = verificationId;
              _message = 'تم إرسال رمز التحقق';
            });
          }
        },
        codeAutoRetrievalTimeout: (verificationId) {
          if (mounted) setState(() => _verificationId = verificationId);
        },
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verifyCode() async {
    final verificationId = _verificationId;
    if (verificationId == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final credential = PhoneAuthProvider.credential(
        verificationId: verificationId,
        smsCode: _codeController.text.trim(),
      );
      await FirebaseAuth.instance.signInWithCredential(credential);
      await logAnalyticsEvent(role: widget.role, name: 'login_completed');
    } catch (error) {
      if (mounted) setState(() => _message = 'رمز التحقق غير صحيح أو منتهي');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _AuthScaffold(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.role == 'DRIVER' ? 'دخول الكابتن' : 'دخول العميل',
                style: Theme.of(context).textTheme.titleLarge,
                textAlign: TextAlign.right,
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                textDirection: TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'رقم الجوال',
                  prefixIcon: Icon(Icons.phone_outlined),
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: _busy ? null : _sendCode,
                icon: const Icon(Icons.sms_outlined),
                label: Text(_busy ? 'جارٍ الإرسال...' : 'إرسال رمز OTP'),
              ),
              if (_verificationId != null) ...[
                const SizedBox(height: 12),
                TextField(
                  controller: _codeController,
                  keyboardType: TextInputType.number,
                  textDirection: TextDirection.ltr,
                  decoration: const InputDecoration(
                    labelText: 'رمز التحقق',
                    prefixIcon: Icon(Icons.lock_outline),
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _busy ? null : _verifyCode,
                  icon: const Icon(Icons.verified_user_outlined),
                  label: const Text('تأكيد الدخول'),
                ),
              ],
              if (_message != null) ...[
                const SizedBox(height: 12),
                Text(_message!, textAlign: TextAlign.right),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class OfflineSyncCard extends StatefulWidget {
  const OfflineSyncCard({super.key, required this.api});

  final MishwarApi api;

  @override
  State<OfflineSyncCard> createState() => _OfflineSyncCardState();
}

class _OfflineSyncCardState extends State<OfflineSyncCard> {
  int _pending = 0;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final pending = await widget.api.pendingOfflineMutationsCount();
    if (mounted) setState(() => _pending = pending);
  }

  Future<void> _sync() async {
    setState(() => _syncing = true);
    await widget.api.syncOfflineQueue();
    await _load();
    if (mounted) setState(() => _syncing = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_pending == 0) return const SizedBox.shrink();
    return Card(
      child: ListTile(
        leading:
            const Icon(Icons.cloud_sync_outlined, color: MishwarBrand.accent),
        title: const Text('عمليات بانتظار المزامنة'),
        subtitle: Text('$_pending عملية محفوظة بسبب انقطاع الاتصال'),
        trailing: IconButton(
          tooltip: 'مزامنة',
          onPressed: _syncing ? null : _sync,
          icon: _syncing
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.refresh),
        ),
      ),
    );
  }
}

class _AuthScaffold extends StatelessWidget {
  const _AuthScaffold({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: MishwarBrand.gradient),
        child: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: child,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AuthMessage extends StatelessWidget {
  const _AuthMessage({required this.title, required this.message});

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline,
                color: MishwarBrand.accent, size: 34),
            const SizedBox(height: 12),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
