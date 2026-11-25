import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import 'console_common.dart';

/// 管理②：実行の詳細。ジョブと手順、ジョブごとのログ、再実行・取り消し
class ConsoleRunDetailScreen extends StatefulWidget {
  const ConsoleRunDetailScreen({super.key, required this.service, required this.runId});
  final ConsoleService service;
  final String runId;

  @override
  State<ConsoleRunDetailScreen> createState() => _ConsoleRunDetailScreenState();
}

class _ConsoleRunDetailScreenState extends State<ConsoleRunDetailScreen> with Loadable {
  RunDetail? _detail;
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        _detail = await widget.service.fetchRun(widget.runId);
      });

  Future<void> _act(Future<void> Function() action, String doneMessage) async {
    setState(() => _acting = true);
    try {
      await action();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(doneMessage)));
      await _reload();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _detail;
    final run = d?.run;
    final st = run == null ? null : RunStatusStyle.of(run.status, run.conclusion);
    return Scaffold(
      appBar: AppBar(title: Text(run == null ? '実行の詳細' : '${run.repo} #${run.number}')),
      body: LoadView(
        loading: loading && d == null,
        error: d == null ? loadError : null,
        configured: true,
        onRetry: _reload,
        child: d == null
            ? const SizedBox.shrink()
            : ListView(padding: const EdgeInsets.all(16), children: [
                Row(children: [
                  Icon(st!.icon, color: st.color(Theme.of(context).colorScheme)),
                  const SizedBox(width: 8),
                  Text('${st.label}・${run!.workflow}'),
                ]),
                const SizedBox(height: 4),
                Text('${run.event}・${run.branch}・${formatTime(run.createdAt)}', style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: 16),
                Row(children: [
                  FilledButton.icon(
                    onPressed: _acting || run.isActive ? null : () => _act(() => widget.service.rerun(run.runId), '再実行を受け付けました'),
                    icon: const Icon(Icons.replay),
                    label: const Text('再実行'),
                  ),
                  const SizedBox(width: 12),
                  OutlinedButton.icon(
                    onPressed: _acting || !run.isActive ? null : () => _act(() => widget.service.cancel(run.runId), '取り消しました'),
                    icon: const Icon(Icons.cancel_outlined),
                    label: const Text('取り消し'),
                  ),
                ]),
                const SizedBox(height: 24),
                Text('ジョブ', style: Theme.of(context).textTheme.titleMedium),
                for (final job in d.jobs) _JobSection(service: widget.service, job: job),
              ]),
      ),
    );
  }
}

class _JobSection extends StatefulWidget {
  const _JobSection({required this.service, required this.job});
  final ConsoleService service;
  final JobItem job;

  @override
  State<_JobSection> createState() => _JobSectionState();
}

class _JobSectionState extends State<_JobSection> {
  String? _logs;
  bool _loadingLogs = false;
  String? _logError;

  Future<void> _toggleLogs() async {
    if (_logs != null) {
      setState(() => _logs = null);
      return;
    }
    setState(() {
      _loadingLogs = true;
      _logError = null;
    });
    try {
      final text = await widget.service.fetchLogs(widget.job.jobId);
      if (mounted) setState(() => _logs = text);
    } catch (e) {
      if (mounted) setState(() => _logError = '$e');
    } finally {
      if (mounted) setState(() => _loadingLogs = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final job = widget.job;
    final t = Theme.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(job.name, style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
            Text(job.status),
          ]),
          if (job.runner != null) Text('Runner：${job.runner}', style: t.textTheme.bodySmall),
          if (job.reason != null) Text(job.reason!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
          for (final step in job.steps)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(children: [
                Icon(step.status == 'success' ? Icons.check_circle_outline : (step.status == 'failure' ? Icons.error_outline : Icons.radio_button_unchecked), size: 16),
                const SizedBox(width: 6),
                Expanded(child: Text(step.name)),
                if (step.exitCode != null) Text('exit ${step.exitCode}'),
              ]),
            ),
          const SizedBox(height: 8),
          TextButton.icon(
            onPressed: _loadingLogs ? null : _toggleLogs,
            icon: const Icon(Icons.terminal),
            label: Text(_logs != null ? 'ログを閉じる' : 'ログを見る'),
          ),
          if (_loadingLogs) const LinearProgressIndicator(),
          if (_logError != null) Text(_logError!, style: TextStyle(color: t.colorScheme.error)),
          if (_logs != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: t.colorScheme.surfaceContainerLow, borderRadius: BorderRadius.circular(8)),
              child: SelectableText(_logs!, style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
            ),
        ]),
      ),
    );
  }
}
