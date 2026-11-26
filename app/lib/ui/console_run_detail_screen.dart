import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import '../core/operation_labels.dart';
import 'app_badge.dart';
import 'console_common.dart';

/// 管理②：実行の詳細。ヘッダーカード、ジョブと手順のタイムライン、ログ、再実行・取り消し、
/// この実行に紐づく操作の記録
class ConsoleRunDetailScreen extends StatefulWidget {
  const ConsoleRunDetailScreen({super.key, required this.service, required this.runId});
  final ConsoleService service;
  final String runId;

  @override
  State<ConsoleRunDetailScreen> createState() => _ConsoleRunDetailScreenState();
}

class _ConsoleRunDetailScreenState extends State<ConsoleRunDetailScreen> with Loadable {
  RunDetail? _detail;
  List<OperationItem> _operations = [];
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        _detail = await widget.service.fetchRun(widget.runId);
        // 紐づく操作の記録（道具側に run_id の絞り込みが無いため、取得分から寄せる）
        final ops = await widget.service.fetchOperations(limit: 100);
        _operations = ops.where((o) => o.runId == widget.runId).toList();
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
    return Scaffold(
      appBar: AppBar(title: Text(run == null ? '実行の詳細' : '${repoDisplayName(run.repo)} #${run.number}')),
      body: LoadView(
        loading: loading && d == null,
        error: d == null ? loadError : null,
        configured: true,
        onRetry: _reload,
        child: d == null
            ? const SizedBox.shrink()
            : ListView(padding: const EdgeInsets.all(16), children: [
                _headerCard(context, run!),
                const SizedBox(height: 12),
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
                Text('ジョブ', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                for (final job in d.jobs) _JobSection(service: widget.service, job: job),
                if (_operations.isNotEmpty) ...[
                  const SizedBox(height: 24),
                  Text('この実行の記録', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  for (final op in _operations) _operationRow(context, op),
                ],
              ]),
      ),
    );
  }

  Widget _headerCard(BuildContext context, RunItem run) {
    final t = Theme.of(context);
    final st = RunStatusStyle.of(run.status, run.conclusion);
    final testFlight = isTestFlightRelated(workflow: run.workflow);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            AppBadge(repo: run.repo, size: 48),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(repoDisplayName(run.repo), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800), overflow: TextOverflow.ellipsis),
                Text(run.repo, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant), overflow: TextOverflow.ellipsis),
              ]),
            ),
            StatusChip(label: st.label, icon: st.icon, tone: st.tone),
          ]),
          const SizedBox(height: 14),
          _row(context, 'ワークフロー', testFlight ? '${run.workflow}（TestFlight 送信）' : run.workflow),
          _row(context, 'きっかけ', runEventLabel(run.event)),
          _row(context, 'ブランチ', run.branch),
          _row(context, '開始', formatTime(run.createdAt)),
          if (run.status == 'completed') _row(context, '所要時間', formatDuration(run.duration)),
        ]),
      ),
    );
  }

  Widget _row(BuildContext context, String label, String value) {
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 84, child: Text(label, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant))),
        Expanded(child: Text(value, style: t.textTheme.bodyMedium)),
      ]),
    );
  }

  Widget _operationRow(BuildContext context, OperationItem op) {
    final t = Theme.of(context);
    final tone = operationTone(op);
    final color = toneColor(tone, t.colorScheme);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(operationKindIcon(op.kind), size: 16, color: color),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${operationTitle(op)}／${op.stage}', style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            if (op.reason != null && op.reason!.isNotEmpty) Text(op.reason!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ]),
        ),
        Text(formatClock(op.createdAt), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
      ]),
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
    final jobStyle = RunStatusStyle.of(job.status == 'success' || job.status == 'failure' ? 'completed' : job.status, job.status == 'success' ? 'success' : (job.status == 'failure' ? 'failure' : null));
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(jobStyle.icon, size: 20, color: jobStyle.color(t.colorScheme)),
            const SizedBox(width: 8),
            Expanded(child: Text(job.name, style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
            if (job.duration != null) Text(formatDuration(job.duration), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ]),
          if (job.runner != null) Text('Runner：${job.runner}', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          if (job.attempt > 1) Text('${job.attempt} 回目', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          if (job.reason != null) Text(job.reason!, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error)),
          const SizedBox(height: 8),
          // 手順のタイムライン（縦線＋状態アイコン＋所要時間）
          for (var i = 0; i < job.steps.length; i++) _stepRow(context, job.steps[i], isLast: i == job.steps.length - 1),
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

  Widget _stepRow(BuildContext context, StepItem step, {required bool isLast}) {
    final t = Theme.of(context);
    final (icon, tone) = switch (step.status) {
      'success' => (Icons.check_circle, 'ok'),
      'failure' => (Icons.error, 'error'),
      'running' => (Icons.play_circle_fill, 'busy'),
      'skipped' => (Icons.skip_next, 'neutral'),
      _ => (Icons.radio_button_unchecked, 'neutral'),
    };
    final color = toneColor(tone, t.colorScheme);
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Column(children: [
          Icon(icon, size: 18, color: color),
          if (!isLast) Expanded(child: Container(width: 2, color: t.colorScheme.outlineVariant)),
        ]),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(bottom: isLast ? 0 : 10),
            child: Row(children: [
              Expanded(child: Text(step.name, style: t.textTheme.bodyMedium)),
              if (step.duration != null) Text(formatDuration(step.duration), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
              if (step.exitCode != null) ...[
                const SizedBox(width: 8),
                Text('exit ${step.exitCode}', style: t.textTheme.bodySmall?.copyWith(color: step.exitCode == 0 ? t.colorScheme.onSurfaceVariant : t.colorScheme.error)),
              ],
            ]),
          ),
        ),
      ]),
    );
  }
}
