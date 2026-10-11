import 'package:flutter/material.dart';
import 'package:mishwar_shared/mishwar_api.dart';
import 'package:mishwar_shared/mishwar_brand.dart';

/// Past rides for the signed-in customer or driver, loaded from `/api/rides/history`.
class RideHistoryList extends StatefulWidget {
  const RideHistoryList({
    super.key,
    required this.api,
    required this.role,
    this.onRideTap,
  });

  final MishwarApi api;

  /// `CUSTOMER` or `DRIVER`.
  final String role;
  final ValueChanged<Map<String, dynamic>>? onRideTap;

  @override
  State<RideHistoryList> createState() => RideHistoryListState();
}

class RideHistoryListState extends State<RideHistoryList> {
  late Future<List<Map<String, dynamic>>> _rides;

  @override
  void initState() {
    super.initState();
    _rides = widget.api.rideHistory(widget.role);
  }

  /// Reloads the list, e.g. after a ride completes.
  void reload() => setState(() => _rides = widget.api.rideHistory(widget.role));

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'الرحلات السابقة',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            IconButton(
              tooltip: 'تحديث السجل',
              onPressed: reload,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        const SizedBox(height: 4),
        FutureBuilder<List<Map<String, dynamic>>>(
          future: _rides,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (snapshot.hasError) {
              return _HistoryMessage(
                icon: Icons.cloud_off_outlined,
                text: 'تعذر تحميل سجل الرحلات. تحقق من الاتصال وحاول مرة أخرى.',
                action: TextButton(onPressed: reload, child: const Text('إعادة المحاولة')),
              );
            }
            final rides = snapshot.data ?? const [];
            if (rides.isEmpty) {
              return const _HistoryMessage(
                icon: Icons.receipt_long_outlined,
                text: 'لا توجد رحلات بعد. ستظهر رحلاتك هنا بعد أول مشوار.',
              );
            }
            return Card(
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  for (var i = 0; i < rides.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    _RideHistoryTile(
                      ride: rides[i],
                      onTap: widget.onRideTap == null ? null : () => widget.onRideTap!(rides[i]),
                    ),
                  ],
                ],
              ),
            );
          },
        ),
      ],
    );
  }
}

class _RideHistoryTile extends StatelessWidget {
  const _RideHistoryTile({required this.ride, this.onTap});

  final Map<String, dynamic> ride;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final status = ride['status']?.toString() ?? '';
    final (label, color, icon) = _statusStyle(status);
    final pickup = _placeName(ride['pickup']);
    final destination = _placeName(ride['destination']);
    final fare = ride['finalFare'] ?? ride['estimatedFare'];
    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: color.withValues(alpha: 0.16),
        child: Icon(icon, color: color, size: 20),
      ),
      title: Text(
        '$pickup ← $destination',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text('${_formatDate(ride['createdAt'])} • $label', style: TextStyle(color: color)),
      trailing: fare == null
          ? null
          : Text(
              '${_formatAmount(fare)} ر.ي',
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
    );
  }

  static (String, Color, IconData) _statusStyle(String status) => switch (status) {
        'TRIP_COMPLETED' => ('مكتمل', MishwarBrand.primary, Icons.check_circle_outline),
        'CANCELLED_BY_CUSTOMER' || 'CANCELLED_BY_PASSENGER' || 'CANCELLED_BY_DRIVER' =>
          ('ملغى', Colors.redAccent, Icons.cancel_outlined),
        'NO_DRIVER_FOUND' || 'NO_DRIVER_AVAILABLE' => ('لم يتوفر كابتن', Colors.orangeAccent, Icons.person_off_outlined),
        'SEARCHING_DRIVER' => ('جارٍ البحث عن كابتن', MishwarBrand.accent, Icons.search),
        _ => ('جارٍ', MishwarBrand.accent, Icons.directions_car_outlined),
      };

  static String _placeName(Object? point) {
    if (point is Map) {
      final name = point['addressName'] ?? point['name'];
      if (name is String && name.trim().isNotEmpty) return name.trim();
    }
    return 'موقع على الخريطة';
  }

  static String _formatDate(Object? value) {
    final parsed = value is String ? DateTime.tryParse(value)?.toLocal() : null;
    if (parsed == null) return '';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${parsed.year}/${two(parsed.month)}/${two(parsed.day)} ${two(parsed.hour)}:${two(parsed.minute)}';
  }

  static String _formatAmount(Object value) {
    final amount = value is num ? value.round() : int.tryParse(value.toString()) ?? 0;
    final digits = amount.toString();
    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
      buffer.write(digits[i]);
    }
    return buffer.toString();
  }
}

class _HistoryMessage extends StatelessWidget {
  const _HistoryMessage({required this.icon, required this.text, this.action});

  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            Icon(icon, size: 32, color: Colors.white54),
            const SizedBox(height: 8),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
            if (action != null) action!,
          ],
        ),
      ),
    );
  }
}
