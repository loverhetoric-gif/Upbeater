import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import 'console_common.dart';
import 'console_run_detail_screen.dart';

/// 管理①：実行一覧（リポジトリごとにまとめて表示）
class ConsoleRunsScreen extends StatefulWidget {
  const ConsoleRunsScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleRunsScreen> createState() => _ConsoleRunsScreenState();
}

class _ConsoleRunsScreenState extends State<ConsoleRunsScreen> with Loadable {
  List<RunItem> _runs = [];

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        if (widget.service.configured) _runs = await widget.service.fetchRuns();
      });

  @override
  Widget build(BuildContext context) {
    return LoadView(
      loading: loading && _runs.isEmpty,
      error: _runs.isEmpty ? loadError : null,
      configured: widget.service.configured,
      onRetry: _reload,
      child: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: [
          if (loadError != null)
            ListTile(leading: const Icon(Icons.warning_amber), title: Text(loadError!), trailing: IconButton(icon: const Icon(Icons.refresh), onPressed: _reload)),
          if (_runs.isEmpty) const ListTile(title: Text('実行はまだありません')),
          for (final entry in _groups().entries) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
              child: Text(entry.key, style: Theme.of(context).textTheme.titleSmall),
            ),
            for (final run in entry.value) _tile(context, run),
          ],
        ]),
      ),
    );
  }

  Map<String, List<RunItem>> _groups() {
    final groups = <String, List<RunItem>>{};
    for (final r in _runs) {
      groups.putIfAbsent(r.repo, () => []).add(r);
    }
    return groups;
  }

  Widget _tile(BuildContext context, RunItem run) {
    final st = RunStatusStyle.of(run.status, run.conclusion);
    return ListTile(
      leading: Icon(st.icon, color: st.color(Theme.of(context).colorScheme)),
      title: Text('#${run.number} ${run.workflow}'),
      subtitle: Text('${run.event}・${run.branch}・${formatTime(run.createdAt)}'),
      trailing: Text(st.label),
      onTap: () async {
        await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConsoleRunDetailScreen(service: widget.service, runId: run.runId)));
        _reload();
      },
    );
  }
}
