import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import '../core/operation_labels.dart';
import 'app_badge.dart';
import 'console_common.dart';
import 'console_run_detail_screen.dart';

/// 管理①：実行一覧。アプリ（repo）ごとにバッジ付きのカードで出す
class ConsoleRunsScreen extends StatefulWidget {
  const ConsoleRunsScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleRunsScreen> createState() => _ConsoleRunsScreenState();
}

class _ConsoleRunsScreenState extends State<ConsoleRunsScreen> with Loadable {
  List<RunItem> _runs = [];
  String? _repoFilter;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        if (widget.service.configured) _runs = await widget.service.fetchRuns();
      });

  List<String> get _repos {
    final seen = <String>{};
    for (final r in _runs) {
      if (r.repo.isNotEmpty) seen.add(r.repo);
    }
    return seen.toList()..sort();
  }

  List<RunItem> get _visible => _repoFilter == null ? _runs : _runs.where((r) => r.repo == _repoFilter).toList();

  @override
  Widget build(BuildContext context) {
    final visible = _visible;
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
          RepoFilterChips(repos: _repos, selected: _repoFilter, onSelected: (r) => setState(() => _repoFilter = r)),
          if (visible.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('実行はまだありません', textAlign: TextAlign.center),
            ),
          for (final run in visible) _card(context, run),
          const SizedBox(height: 16),
        ]),
      ),
    );
  }

  Widget _card(BuildContext context, RunItem run) {
    final t = Theme.of(context);
    final st = RunStatusStyle.of(run.status, run.conclusion);
    final testFlight = isTestFlightRelated(workflow: run.workflow);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () async {
            await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConsoleRunDetailScreen(service: widget.service, runId: run.runId)));
            _reload();
          },
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                AppBadge(repo: run.repo, size: 42),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(repoDisplayName(run.repo), style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
                    Text('#${run.number} ${run.workflow}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant), overflow: TextOverflow.ellipsis),
                  ]),
                ),
                StatusChip(label: st.label, icon: st.icon, tone: st.tone),
              ]),
              const SizedBox(height: 10),
              Wrap(spacing: 12, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                _meta(context, Icons.bolt_outlined, testFlight ? 'TestFlight 送信' : runEventLabel(run.event)),
                _meta(context, Icons.commit, run.branch),
                _meta(context, Icons.schedule, formatRelative(run.createdAt)),
                if (run.status == 'completed' && run.duration != null) _meta(context, Icons.timer_outlined, formatDuration(run.duration)),
                if (run.isActive) _meta(context, Icons.hourglass_top, '開始から ${formatDuration(DateTime.now().difference(run.createdAt ?? DateTime.now()))}'),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _meta(BuildContext context, IconData icon, String text) {
    final t = Theme.of(context);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 14, color: t.colorScheme.onSurfaceVariant),
      const SizedBox(width: 4),
      Text(text, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
    ]);
  }
}
