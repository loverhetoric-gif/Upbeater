import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import '../core/operation_labels.dart';
import 'app_badge.dart';
import 'console_common.dart';
import 'theme.dart';

/// 管理③：配布状況。リポジトリごとのカードに、OS ごとの最新の版と端末ごとの導入状況をまとめる
class ConsoleDistributionScreen extends StatefulWidget {
  const ConsoleDistributionScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleDistributionScreen> createState() => _ConsoleDistributionScreenState();
}

class _ConsoleDistributionScreenState extends State<ConsoleDistributionScreen> with Loadable {
  List<RepoItem> _repos = [];
  final Map<String, InstallStatus> _statuses = {};
  List<DeviceItem> _devices = [];

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() => load(() async {
        if (!widget.service.configured) return;
        _repos = await widget.service.fetchRepos();
        _devices = await widget.service.fetchDevices();
        _statuses.clear();
        for (final repo in _repos) {
          try {
            _statuses[repo.fullName] = await widget.service.fetchInstallStatus(repo.fullName);
          } catch (_) {
            // 1つの repo の失敗で全体を落とさない（カード側で未取得として出す）
          }
        }
      });

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return LoadView(
      loading: loading && _repos.isEmpty,
      error: _repos.isEmpty ? loadError : null,
      configured: widget.service.configured,
      onRetry: _reload,
      child: RefreshIndicator(
        onRefresh: _reload,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          if (_repos.isEmpty) const Text('登録されているリポジトリがありません'),
          for (final repo in _repos) ...[
            _repoCard(context, repo, _statuses[repo.fullName]),
            const SizedBox(height: 14),
          ],
          const SizedBox(height: 6),
          Text('登録端末', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          if (_devices.isEmpty) const ListTile(title: Text('登録端末がありません')),
          for (final d in _devices)
            Card(
              margin: const EdgeInsets.symmetric(vertical: 4),
              child: ListTile(
                leading: Icon(d.os == 'ios' || d.os == 'android' ? Icons.smartphone : Icons.computer),
                title: Text(d.name),
                subtitle: Text('${d.os}・最終照合 ${formatRelative(d.lastSeenAt)}'),
              ),
            ),
        ]),
      ),
    );
  }

  Widget _repoCard(BuildContext context, RepoItem repo, InstallStatus? status) {
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          RepoTitle(repo: repo.fullName, size: 44),
          if (repo.paused) ...[
            const SizedBox(height: 8),
            const StatusChip(label: '一時停止中', icon: Icons.pause_circle_outline, tone: 'warn'),
          ],
          const SizedBox(height: 14),
          if (status == null)
            Text('配布状況を取得できませんでした', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.error))
          else ...[
            for (final platform in _platforms(status)) _platformRow(context, status, platform),
            if (status.devices.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text('端末ごとの導入状況', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              for (final d in status.devices) _deviceRow(context, d),
            ] else
              Text('まだ導入の報告がありません', style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ],
        ]),
      ),
    );
  }

  List<String> _platforms(InstallStatus status) {
    final set = <String>{};
    for (final r in status.releases) {
      set.add(r.platform);
    }
    for (final d in status.devices) {
      set.add(d.os);
    }
    return set.toList()..sort();
  }

  Widget _platformRow(BuildContext context, InstallStatus status, String platform) {
    final t = Theme.of(context);
    final latest = status.latestReady(platform);
    final setting = status.settingOf(platform);
    final notes = <String>[
      if (setting?.paused == true) '一時停止中',
      if (setting?.pinnedSeq != null) '通番 ${setting!.pinnedSeq} に固定',
      if (setting?.staged == true) '段階配信',
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(platform == 'ios' || platform == 'android' ? Icons.phone_iphone : Icons.desktop_windows_outlined, color: t.colorScheme.onSurfaceVariant),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(platform, style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
            Text(
              latest == null ? '配布できる版がありません' : '最新の版：通番 ${latest.seq}（${latest.filename}）・${formatRelative(latest.createdAt)}',
              style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
            if (notes.isNotEmpty) Text(notes.join('・'), style: t.textTheme.bodySmall?.copyWith(color: toneColor('warn', t.colorScheme))),
          ]),
        ),
        if (latest != null) const StatusChip(label: '配布可', icon: Icons.check_circle_outline, tone: 'ok'),
      ]),
    );
  }

  Widget _deviceRow(BuildContext context, InstallItem d) {
    final t = Theme.of(context);
    final st = StatusStyle.of(d.status);
    final color = st.color(t.colorScheme);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(st.icon, size: 20, color: color),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${d.device}（${d.os}）', style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
            Text(
              '通番 ${d.seq}${d.targeted ? '' : '・配布先の指定外'}${d.message != null ? '\n${d.message}' : ''}',
              style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
          ]),
        ),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(st.label, style: t.textTheme.bodySmall?.copyWith(color: color, fontWeight: FontWeight.w600)),
          Text(formatRelative(d.updatedAt), style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
        ]),
      ]),
    );
  }
}
