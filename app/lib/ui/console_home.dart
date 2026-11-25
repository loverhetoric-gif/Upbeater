import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';

import '../console_service.dart';
import 'console_attention_screen.dart';
import 'console_distribution_screen.dart';
import 'console_runs_screen.dart';
import 'console_settings_screen.dart';

/// 管理画面の入口。Face ID（生体認証）で開く。
/// 認証の部品が無い・登録が無い端末では、その旨を出してから入る（v1 の割り切り。
/// トークン自体は OS の安全な保管場所にあり、認証なしでは取り出せない端末が大半）
class ConsoleLockGate extends StatefulWidget {
  const ConsoleLockGate({super.key, required this.service, this.authenticator});
  final ConsoleService service;

  /// テスト用に差し替えられる認証関数（null なら local_auth を使う）
  final Future<bool> Function()? authenticator;

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
    if (_unlocked) return ConsoleHome(service: widget.service, note: _note);
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

/// 管理画面のタブ（実行・配布・要対応・設定）
class ConsoleHome extends StatefulWidget {
  const ConsoleHome({super.key, required this.service, this.note});
  final ConsoleService service;
  final String? note;

  @override
  State<ConsoleHome> createState() => _ConsoleHomeState();
}

class _ConsoleHomeState extends State<ConsoleHome> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      ConsoleRunsScreen(service: widget.service),
      ConsoleDistributionScreen(service: widget.service),
      ConsoleAttentionScreen(service: widget.service),
      ConsoleSettingsScreen(service: widget.service),
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('Upbeater 管理')),
      body: Column(children: [
        if (widget.note != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Text(widget.note!, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)),
          ),
        Expanded(child: IndexedStack(index: _index, children: pages)),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.playlist_play), label: '実行'),
          NavigationDestination(icon: Icon(Icons.system_update), label: '配布'),
          NavigationDestination(icon: Icon(Icons.warning_amber_outlined), label: '要対応'),
          NavigationDestination(icon: Icon(Icons.settings_outlined), label: '設定'),
        ],
      ),
    );
  }
}
