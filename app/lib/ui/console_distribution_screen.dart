import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/console_models.dart';
import 'console_common.dart';

/// 管理③：配布状況。リポジトリを選ぶと、OS ごとの最新の版と端末ごとの導入状況を出す
class ConsoleDistributionScreen extends StatefulWidget {
  const ConsoleDistributionScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleDistributionScreen> createState() => _ConsoleDistributionScreenState();
}

class _ConsoleDistributionScreenState extends State<ConsoleDistributionScreen> with Loadable {
  List<RepoItem> _repos = [];
  String? _repo;
  InstallStatus? _status;
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
        _repo ??= _repos.isNotEmpty ? _repos.first.fullName : null;
        if (_repo != null) _status = await widget.service.fetchInstallStatus(_repo!);
      });

  Future<void> _select(String repo) async {
    setState(() => _repo = repo);
    await load(() async {
      _status = await widget.service.fetchInstallStatus(repo);
    });
  }

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
          if (_repos.isNotEmpty)
            DropdownButtonFormField<String>(
              initialValue: _repo,
              decoration: const InputDecoration(labelText: 'リポジトリ'),
              items: [for (final r in _repos) DropdownMenuItem(value: r.fullName, child: Text(r.fullName))],
              onChanged: (v) {
                if (v != null) _select(v);
              },
            ),
          const SizedBox(height: 16),
          if (_status != null) ...[
            Text('配布できる版', style: t.textTheme.titleMedium),
            const SizedBox(height: 8),
            for (final platform in _platforms()) _platformCard(context, platform),
            const SizedBox(height: 20),
            Text('端末ごとの導入状況', style: t.textTheme.titleMedium),
            if (_status!.devices.isEmpty) const ListTile(title: Text('まだ導入の報告がありません')),
            for (final d in _status!.devices)
              ListTile(
                leading: const Icon(Icons.devices_other),
                title: Text('${d.device}（${d.os}）'),
                subtitle: Text('通番 ${d.seq}・${d.status}${d.targeted ? '' : '・配布先の指定外'}${d.message != null ? '\n${d.message}' : ''}'),
                trailing: Text(formatTime(d.updatedAt)),
              ),
          ],
          const SizedBox(height: 20),
          Text('登録端末', style: t.textTheme.titleMedium),
          if (_devices.isEmpty) const ListTile(title: Text('登録端末がありません')),
          for (final d in _devices)
            ListTile(
              leading: const Icon(Icons.smartphone),
              title: Text(d.name),
              subtitle: Text('${d.os}・最終照合 ${formatTime(d.lastSeenAt)}'),
            ),
        ]),
      ),
    );
  }

  List<String> _platforms() {
    final set = <String>{};
    for (final r in _status!.releases) {
      set.add(r.platform);
    }
    for (final d in _status!.devices) {
      set.add(d.os);
    }
    return set.toList()..sort();
  }

  Widget _platformCard(BuildContext context, String platform) {
    final t = Theme.of(context);
    final latest = _status!.latestReady(platform);
    final setting = _status!.settingOf(platform);
    final notes = <String>[
      if (setting?.paused == true) '一時停止中',
      if (setting?.pinnedSeq != null) '通番 ${setting!.pinnedSeq} に巻き戻し固定',
      if (setting?.staged == true) '段階配信',
    ];
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: const Icon(Icons.system_update),
        title: Text(platform),
        subtitle: Text(latest == null ? '配布できる版がありません' : '最新の版：通番 ${latest.seq}（${latest.filename}）'),
        trailing: notes.isEmpty ? null : Text(notes.join('・'), style: t.textTheme.bodySmall),
      ),
    );
  }
}
