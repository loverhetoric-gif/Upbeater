import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import '../core/operation_labels.dart';
import 'app_badge.dart';
import 'console_common.dart';

/// 管理：履歴（操作の記録）。いつ・どのアプリで・何があったかを具体的に出す。
/// マージ、TestFlight 送信、手動実行、配布、導入などを日付ごとに時系列で並べる
class ConsoleHistoryScreen extends StatefulWidget {
  const ConsoleHistoryScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleHistoryScreen> createState() => _ConsoleHistoryScreenState();
}

class _ConsoleHistoryScreenState extends State<ConsoleHistoryScreen> with Loadable {
  List<OperationItem> _items = [];
  String? _repoFilter;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        if (widget.service.configured) _items = await widget.service.fetchOperations(limit: 100);
      });

  List<String> get _repos {
    final seen = <String>{};
    for (final o in _items) {
      if (o.repo != null && o.repo!.isNotEmpty) seen.add(o.repo!);
    }
    return seen.toList()..sort();
  }

  List<OperationItem> get _visible => _repoFilter == null ? _items : _items.where((o) => o.repo == _repoFilter).toList();

  @override
  Widget build(BuildContext context) {
    final visible = _visible;
    return LoadView(
      loading: loading && _items.isEmpty,
      error: _items.isEmpty ? loadError : null,
      configured: widget.service.configured,
      onRetry: _reload,
      child: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: [
          if (loadError != null)
            ListTile(leading: const Icon(Icons.warning_amber), title: Text(loadError!), trailing: IconButton(icon: const Icon(Icons.refresh), onPressed: _reload)),
          RepoFilterChips(repos: _repos, selected: _repoFilter, onSelected: (r) => setState(() => _repoFilter = r)),
          if (visible.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('記録はまだありません', textAlign: TextAlign.center),
            ),
          for (final entry in _groups(visible).entries) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 6),
              child: Text(entry.key, style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
            ),
            for (final op in entry.value) _row(context, op),
          ],
          const SizedBox(height: 16),
        ]),
      ),
    );
  }

  Map<String, List<OperationItem>> _groups(List<OperationItem> items) {
    final groups = <String, List<OperationItem>>{};
    for (final o in items) {
      final key = o.createdAt == null ? '日時不明' : dateGroupLabel(o.createdAt!);
      groups.putIfAbsent(key, () => []).add(o);
    }
    return groups;
  }

  Widget _row(BuildContext context, OperationItem op) {
    final t = Theme.of(context);
    final tone = operationTone(op);
    final color = toneColor(tone, t.colorScheme);
    final detail = operationDetailLine(op);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            AppBadge(repo: op.repo, size: 38),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(
                    child: Text(repoDisplayName(op.repo), style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
                  ),
                  Text(formatClock(op.createdAt), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ]),
                const SizedBox(height: 4),
                Row(children: [
                  Icon(operationKindIcon(op.kind), size: 15, color: color),
                  const SizedBox(width: 5),
                  Flexible(child: Text(operationTitle(op), style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
                  if (op.needsHuman) ...[
                    const SizedBox(width: 8),
                    StatusChip(label: '要対応', icon: Icons.warning_amber, tone: 'attention'),
                  ] else if (op.status == 'failed') ...[
                    const SizedBox(width: 8),
                    StatusChip(label: '失敗', icon: Icons.error_outline, tone: 'error'),
                  ] else if (op.status == 'retry') ...[
                    const SizedBox(width: 8),
                    StatusChip(label: '再試行中', icon: Icons.refresh, tone: 'warn'),
                  ],
                ]),
                if (op.reason != null && op.reason!.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(op.reason!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ],
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(detail, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                ],
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
