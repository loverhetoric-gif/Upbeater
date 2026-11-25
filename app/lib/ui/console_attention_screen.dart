import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import 'console_common.dart';

/// 管理④：要対応（人の判断が要る失敗、list_operations の needs_human）
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
    final t = Theme.of(context);
    return LoadView(
      loading: loading && _items.isEmpty,
      error: _items.isEmpty ? loadError : null,
      configured: widget.service.configured,
      onRetry: _reload,
      child: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: [
          if (_items.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('人の判断が要るものはありません', textAlign: TextAlign.center),
            ),
          for (final o in _items)
            ListTile(
              leading: Icon(Icons.warning_amber, color: t.colorScheme.error),
              title: Text('${o.repo ?? '—'}・${o.kind}／${o.stage}'),
              subtitle: Text('${o.status}${o.reason != null ? '\n${o.reason}' : ''}'),
              trailing: Text(formatTime(o.createdAt)),
            ),
        ]),
      ),
    );
  }
}
