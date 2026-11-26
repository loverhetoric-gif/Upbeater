import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import '../core/operation_labels.dart';
import 'app_badge.dart';
import 'console_common.dart';

/// 管理④：要対応（人の判断が要る失敗、list_operations の needs_human）。
/// 重要度が伝わるよう、左帯の色と経過時間つきのカードで出す
class ConsoleAttentionScreen extends StatefulWidget {
  const ConsoleAttentionScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleAttentionScreen> createState() => _ConsoleAttentionScreenState();
}

class _ConsoleAttentionScreenState extends State<ConsoleAttentionScreen> with Loadable {
  List<OperationItem> _items = [];

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        if (widget.service.configured) _items = await widget.service.fetchNeedsHuman();
      });

  @override
  Widget build(BuildContext context) {
    return LoadView(
      loading: loading && _items.isEmpty,
      error: _items.isEmpty ? loadError : null,
      configured: widget.service.configured,
      onRetry: _reload,
      child: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
          if (_items.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Column(children: [
                Icon(Icons.check_circle_outline, size: 40, color: Color(0xFF2FBF71)),
                SizedBox(height: 10),
                Text('人の判断が要るものはありません', textAlign: TextAlign.center),
              ]),
            ),
          for (final o in _items) _card(context, o),
        ]),
      ),
    );
  }

  Widget _card(BuildContext context, OperationItem o) {
    final t = Theme.of(context);
    final failed = o.status == 'failed';
    final bandColor = toneColor(failed ? 'error' : 'attention', t.colorScheme);
    final detail = operationDetailLine(o);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(width: 5, color: bandColor),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    AppBadge(repo: o.repo, size: 38),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(repoDisplayName(o.repo), style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
                        Text('${operationTitle(o)}／${o.stage}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant), overflow: TextOverflow.ellipsis),
                      ]),
                    ),
                    StatusChip(label: failed ? '失敗' : '要対応', icon: Icons.warning_amber, tone: failed ? 'error' : 'attention'),
                  ]),
                  if (o.reason != null && o.reason!.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Text(o.reason!, style: t.textTheme.bodyMedium),
                  ],
                  if (detail.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(detail, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                  ],
                  const SizedBox(height: 8),
                  Row(children: [
                    Icon(Icons.schedule, size: 14, color: t.colorScheme.onSurfaceVariant),
                    const SizedBox(width: 4),
                    Text('${formatTime(o.createdAt)}（${formatRelative(o.createdAt)}）', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    if (o.retryable) ...[
                      const SizedBox(width: 12),
                      Icon(Icons.refresh, size: 14, color: t.colorScheme.onSurfaceVariant),
                      const SizedBox(width: 4),
                      Text('再試行できる場合があります', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                    ],
                  ]),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
