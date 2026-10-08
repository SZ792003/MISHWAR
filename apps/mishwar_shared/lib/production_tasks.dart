import 'package:flutter/material.dart';
import 'package:mishwar_shared/mishwar_brand.dart';

enum ProductionTaskAudience { customer, driver }

enum ProductionTaskStatus { ready, inProgress, next }

class ProductionTask {
  const ProductionTask({
    required this.title,
    required this.description,
    required this.status,
    required this.audiences,
  });

  final String title;
  final String description;
  final ProductionTaskStatus status;
  final Set<ProductionTaskAudience> audiences;
}

const productionTasks = <ProductionTask>[
  ProductionTask(
    title: 'هوية التطبيق وتجهيز الواجهة',
    description: 'الثيم، الكروت، وتنسيق الهوية أصبحت موحدة داخل تطبيق العميل والكابتن.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'فلاتر الطلب الأساسية',
    description: 'نوع المركبة، عدد الركاب، المكيف، وطريقة الدفع جاهزة داخل طلب المشوار.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.customer},
  ),
  ProductionTask(
    title: 'تتبع موقع الكابتن المباشر',
    description: 'إرسال الموقع من تطبيق الكابتن وعرضه للعميل مع تهدئة تحديثات GPS.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'تدفق المشوار',
    description: 'طلب، قبول، وصول، بدء، إنهاء، وإلغاء المشوار مربوطة بأزرار واضحة.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'المصادقة الحقيقية والحسابات',
    description: 'تسجيل الدخول، OTP، إدارة الجلسات، وتعديل الملف الشخصي للعميل والكابتن.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'توثيق الكابتن KYC',
    description: 'رفع ومراجعة بيانات الهوية والمركبة قبل تفعيل استقبال الطلبات.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'الدفع والمحفظة',
    description: 'ربط مزود دفع حقيقي، سجل محفظة، تسويات، واسترجاع مبالغ.',
    status: ProductionTaskStatus.inProgress,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'الإشعارات الفورية',
    description: 'تنبيهات الطلبات، قبول أو رفض الكابتن، تحديثات الرحلة، وتنبيهات السلامة.',
    status: ProductionTaskStatus.ready,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'الأمان و SOS',
    description: 'تصعيد الطوارئ، جهات اتصال السلامة، وبلاغات الحوادث داخل الرحلة.',
    status: ProductionTaskStatus.next,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
  ProductionTask(
    title: 'تجهيز الإطلاق',
    description: 'Firebase الإنتاج، صلاحيات المتجر، اختبارات الأجهزة، وخطة التشغيل التجريبي.',
    status: ProductionTaskStatus.inProgress,
    audiences: {ProductionTaskAudience.customer, ProductionTaskAudience.driver},
  ),
];

class ProductionTasksCard extends StatefulWidget {
  const ProductionTasksCard({
    super.key,
    required this.audience,
    required this.title,
  });

  final ProductionTaskAudience audience;
  final String title;

  @override
  State<ProductionTasksCard> createState() => _ProductionTasksCardState();
}

class _ProductionTasksCardState extends State<ProductionTasksCard> {
  ProductionTaskStatus? _selectedStatus;

  @override
  Widget build(BuildContext context) {
    final visibleTasks = productionTasks
        .where((task) => task.audiences.contains(widget.audience))
        .where((task) => _selectedStatus == null || task.status == _selectedStatus)
        .toList();
    final readyCount = productionTasks
        .where((task) => task.audiences.contains(widget.audience) && task.status == ProductionTaskStatus.ready)
        .length;
    final totalCount = productionTasks.where((task) => task.audiences.contains(widget.audience)).length;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.task_alt_rounded, color: MishwarBrand.primary),
                const SizedBox(width: 10),
                Expanded(child: Text(widget.title, style: Theme.of(context).textTheme.titleMedium)),
                Text('$readyCount/$totalCount', style: Theme.of(context).textTheme.labelLarge),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _TaskFilterChip(
                  label: 'الكل',
                  selected: _selectedStatus == null,
                  onSelected: () => setState(() => _selectedStatus = null),
                ),
                for (final status in ProductionTaskStatus.values)
                  _TaskFilterChip(
                    label: _statusLabel(status),
                    selected: _selectedStatus == status,
                    onSelected: () => setState(() => _selectedStatus = status),
                  ),
              ],
            ),
            const SizedBox(height: 14),
            for (final task in visibleTasks) _TaskRow(task: task),
          ],
        ),
      ),
    );
  }
}

class _TaskFilterChip extends StatelessWidget {
  const _TaskFilterChip({
    required this.label,
    required this.selected,
    required this.onSelected,
  });

  final String label;
  final bool selected;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) {
    return FilterChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onSelected(),
      showCheckmark: false,
      selectedColor: MishwarBrand.primary.withOpacity(0.22),
      side: BorderSide(color: selected ? MishwarBrand.primary : Colors.white24),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.task});

  final ProductionTask task;

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(task.status);
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: color.withOpacity(0.16),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(_statusIcon(task.status), color: color, size: 18),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(task.title, style: const TextStyle(fontWeight: FontWeight.w700))),
                    const SizedBox(width: 8),
                    Text(_statusLabel(task.status), style: TextStyle(color: color, fontSize: 11)),
                  ],
                ),
                const SizedBox(height: 3),
                Text(task.description, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String _statusLabel(ProductionTaskStatus status) => switch (status) {
      ProductionTaskStatus.ready => 'جاهز',
      ProductionTaskStatus.inProgress => 'قيد العمل',
      ProductionTaskStatus.next => 'التالي',
    };

Color _statusColor(ProductionTaskStatus status) => switch (status) {
      ProductionTaskStatus.ready => const Color(0xFF10B981),
      ProductionTaskStatus.inProgress => const Color(0xFFF59E0B),
      ProductionTaskStatus.next => const Color(0xFF60A5FA),
    };

IconData _statusIcon(ProductionTaskStatus status) => switch (status) {
      ProductionTaskStatus.ready => Icons.check_circle_outline,
      ProductionTaskStatus.inProgress => Icons.pending_actions_outlined,
      ProductionTaskStatus.next => Icons.radio_button_unchecked,
    };
