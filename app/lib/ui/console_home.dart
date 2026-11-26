import 'dart:async';

import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';

import '../console_service.dart';
import '../core/operation_labels.dart';
import '../notification_service.dart';
import 'console_attention_screen.dart';
import 'console_distribution_screen.dart';
import 'console_history_screen.dart';
import 'console_runs_screen.dart';
import 'console_settings_screen.dart';
import 'theme.dart';

/// 管理画面の入口。Face ID（生体認証）で開く。
/// 認証の部品が無い・登録が無い端末では、その旨を出してから入る（v1 の割り切り。
/// トークン自体は OS の安全な保管場所にあり、認証なしでは取り出せない端末が大半）
class ConsoleLockGate extends StatefulWidget {
  const ConsoleLockGate({super.key, required this.service, this.authenticator, this.notifier});
  final ConsoleService service;

  /// テスト用に差し替えられる認証関数（null なら local_auth を使う）
  final Future<bool> Function()? authenticator;

  /// 完了通知の確認役（null なら通知の定期確認をしない）
  final ConsoleNotifier? notifier;

  @override
  State<ConsoleLockGate> createState() => _ConsoleLockGateState();
}

class _ConsoleLockGateState extends State<ConsoleLockGate> {
  bool _unlocked = false;
  bool _checking = true;
  String? _note;

  @override
  void initState() {
    super.initState();
    _tryAuth();
  }

  Future<bool> _authenticate() async {
    if (widget.authenticator != null) return widget.authenticator!();
    final auth = LocalAuthentication();
    final supported = await auth.isDeviceSupported();
    if (!supported) return true; // 認証の仕組み自体が無い端末（Mac の一部など）はそのまま
    final available = await auth.canCheckBiometrics;
    if (!available) {
      _note = '生体認証が登録されていません。端末の設定で Face ID を登録すると、次回から認証が必要になります';
      return true;
    }
    return auth.authenticate(
      localizedReason: 'Upbeater の管理画面を開きます',
      options: const AuthenticationOptions(stickyAuth: true, biometricOnly: false),
    );
  }

  Future<void> _tryAuth() async {
    setState(() => _checking = true);
    var ok = false;
    try {
      ok = await _authenticate();
    } catch (_) {
      ok = false;
    }
    if (mounted) {
      setState(() {
        _unlocked = ok;
        _checking = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_unlocked) return ConsoleHome(service: widget.service, note: _note, notifier: widget.notifier);
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.lock_outline, size: 44),
            const SizedBox(height: 12),
            Text(_checking ? '認証しています…' : '管理画面はロックされています'),
            const SizedBox(height: 16),
            if (!_checking) FilledButton.icon(onPressed: _tryAuth, icon: const Icon(Icons.fingerprint), label: const Text('Face ID で開く')),
          ]),
        ),
      ),
    );
  }
}

/// 管理画面のタブ（実行・履歴・配布・要対応・設定）とサマリーヘッダー。
/// 開いている間は通知の定期確認（ポーリング）も回す
class ConsoleHome extends StatefulWidget {
  const ConsoleHome({super.key, required this.service, this.note, this.notifier});
  final ConsoleService service;
  final String? note;
  final ConsoleNotifier? notifier;

  @override
  State<ConsoleHome> createState() => _ConsoleHomeState();
}

class _ConsoleHomeState extends State<ConsoleHome> with WidgetsBindingObserver {
  int _index = 0;
  int _running = 0;
  int _failures = 0;
  int _attention = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.service.addListener(_onServiceChanged);
    widget.notifier?.startPolling();
    _refreshSummary();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.service.removeListener(_onServiceChanged);
    widget.notifier?.stopPolling();
    super.dispose();
  }

  void _onServiceChanged() => _refreshSummary();

  /// 復帰時はその場で確認する（ポーリングの間隔を待たない）
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_quietNotifyCheck());
      _refreshSummary();
    }
  }

  Future<void> _quietNotifyCheck() async {
    try {
      await widget.notifier?.checkNow();
    } catch (_) {
      // 通知確認の失敗は画面に持ち込まない
    }
  }

  Future<void> _refreshSummary() async {
    if (!widget.service.configured) return;
    try {
      final runs = await widget.service.fetchRuns(limit: 50);
      final attention = await widget.service.fetchNeedsHuman(limit: 50);
      if (!mounted) return;
      setState(() {
        _running = runs.where((r) => r.isActive).length;
        _failures = runs.where((r) => r.status == 'completed' && r.isFailure).length;
        _attention = attention.length;
      });
    } catch (_) {
      // サマリーは補助表示。失敗しても各タブ側で改めて出す
    }
  }

  void _go(int index) {
    setState(() => _index = index);
    _refreshSummary();
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      ConsoleRunsScreen(service: widget.service),
      ConsoleHistoryScreen(service: widget.service),
      ConsoleDistributionScreen(service: widget.service),
      ConsoleAttentionScreen(service: widget.service),
      ConsoleSettingsScreen(service: widget.service),
    ];
    return Theme(
      data: buildConsoleTheme(),
      child: Builder(
        builder: (context) => Scaffold(
          appBar: AppBar(title: const Text('Upbeater 管理')),
          body: Column(children: [
            if (widget.note != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Text(widget.note!, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)),
              ),
            if (widget.service.configured) _summaryHeader(context),
            Expanded(child: IndexedStack(index: _index, children: pages)),
          ]),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: _go,
            destinations: const [
              NavigationDestination(icon: Icon(Icons.playlist_play), label: '実行'),
              NavigationDestination(icon: Icon(Icons.history), label: '履歴'),
              NavigationDestination(icon: Icon(Icons.system_update), label: '配布'),
              NavigationDestination(icon: Icon(Icons.warning_amber_outlined), label: '要対応'),
              NavigationDestination(icon: Icon(Icons.settings_outlined), label: '設定'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _summaryHeader(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Row(children: [
        _summaryCard(context, label: '実行中', count: _running, icon: Icons.play_circle_fill, color: toneColor('busy', scheme), onTap: () => _go(0)),
        const SizedBox(width: 10),
        _summaryCard(context, label: '直近の失敗', count: _failures, icon: Icons.error_outline, color: toneColor('error', scheme), onTap: () => _go(0)),
        const SizedBox(width: 10),
        _summaryCard(context, label: '対応待ち', count: _attention, icon: Icons.warning_amber, color: toneColor('attention', scheme), onTap: () => _go(3)),
      ]),
    );
  }

  Widget _summaryCard(BuildContext context, {required String label, required int count, required IconData icon, required Color color, required VoidCallback onTap}) {
    final t = Theme.of(context);
    return Expanded(
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(icon, size: 16, color: color),
                const SizedBox(width: 6),
                Expanded(child: Text(label, style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant), overflow: TextOverflow.ellipsis)),
              ]),
              const SizedBox(height: 2),
              Text('$count件', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: count > 0 ? color : null)),
            ]),
          ),
        ),
      ),
    );
  }
}
