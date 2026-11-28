import 'package:flutter/material.dart';

import '../console_service.dart';
import '../core/notification_logic.dart';
import '../notification_service.dart';

/// 管理の設定：Hub の URL と接続コード（一回限り・15 分）。
/// コードは Claude（MCP の道具 create_console_code）か管理 API で発行する。
/// 引き換えで得た接続の控えは端末の安全な保管場所に保存され、画面には出ない。
/// 通知の設定（分類ごとのオン／オフ、テスト通知）もここに置く
class ConsoleSettingsScreen extends StatefulWidget {
  const ConsoleSettingsScreen({super.key, required this.service, this.notifications, this.notificationSink});
  final ConsoleService service;

  /// 通知設定（テスト用に差し替えられる。既定は接続と同じ保管場所を使う）
  final NotificationSettings? notifications;

  /// 通知の送信口（テスト用に差し替えられる）
  final NotificationSink? notificationSink;

  @override
  State<ConsoleSettingsScreen> createState() => _ConsoleSettingsScreenState();
}

class _ConsoleSettingsScreenState extends State<ConsoleSettingsScreen> {
  late final _url = TextEditingController(text: widget.service.hubUrl);
  final _code = TextEditingController();
  late final NotificationSettings _notifications = widget.notifications ?? NotificationSettings(widget.service.secrets);
  late final NotificationSink _sink = widget.notificationSink ?? LocalNotificationSink();
  bool _busy = false;
  String? _message;
  bool _messageIsError = false;

  @override
  void initState() {
    super.initState();
    _notifications.load().then((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _url.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _sendTestNotification() async {
    try {
      await _sink.requestPermission();
      await _sink.show(category: NotifyCategory.runCompleted, id: 1, title: 'Upbeater：テスト通知', body: '実行や配布が完了すると、このように知らせます');
      if (mounted) {
        setState(() {
          _message = 'テスト通知を送りました';
          _messageIsError = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _message = 'テスト通知を送れませんでした：$e';
          _messageIsError = true;
        });
      }
    }
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.service.connectWithCode(hubUrl: _url.text, code: _code.text);
      _code.clear();
      final repos = await widget.service.fetchRepos();
      if (mounted) {
        setState(() {
          _message = '接続できました（リポジトリ ${repos.length} 件）';
          _messageIsError = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _message = '$e';
          _messageIsError = true;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final configured = widget.service.configured;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Hub への接続', style: t.textTheme.titleMedium),
      const SizedBox(height: 12),
      if (configured) ...[
        Row(children: [
          const Icon(Icons.check_circle, color: Color(0xFF1E8E5A), size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text('接続済み（${widget.service.hubUrl}）')),
        ]),
        const SizedBox(height: 16),
      ],
      Text(
        'Claude で発行した接続コードを入力してください。コードは一回限りで、15 分で失効します。',
        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
      ),
      const SizedBox(height: 12),
      TextField(
        controller: _url,
        keyboardType: TextInputType.url,
        autocorrect: false,
        decoration: const InputDecoration(labelText: 'Hub の URL', hintText: 'https://upbeater.loverhetoric.com'),
      ),
      const SizedBox(height: 12),
      TextField(
        controller: _code,
        textCapitalization: TextCapitalization.characters,
        autocorrect: false,
        decoration: const InputDecoration(labelText: '接続コード', hintText: 'XXXXX-XXXXX'),
      ),
      const SizedBox(height: 16),
      FilledButton.icon(
        onPressed: _busy ? null : _connect,
        icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2)) : const Icon(Icons.link),
        label: const Text('接続する'),
      ),
      if (_message != null) ...[
        const SizedBox(height: 12),
        Text(_message!, style: TextStyle(color: _messageIsError ? t.colorScheme.error : const Color(0xFF1E8E5A))),
      ],
      if (configured) ...[
        const SizedBox(height: 24),
        OutlinedButton.icon(
          onPressed: _busy
              ? null
              : () async {
                  await widget.service.clearToken();
                  if (mounted) {
                    setState(() {
                      _message = '接続を解除しました';
                      _messageIsError = false;
                    });
                  }
                },
          icon: const Icon(Icons.link_off),
          label: const Text('接続を解除'),
        ),
      ],
      const SizedBox(height: 32),
      Text('通知', style: t.textTheme.titleMedium),
      const SizedBox(height: 8),
      Text(
        '実行や配布の完了、要対応の発生を知らせます。確認はアプリを開いている間の定期確認と、'
        'iOS のバックグラウンド更新で行います。バックグラウンド更新の間隔は OS が決めるため、'
        '完了してから通知まで時間が空くことがあります。',
        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
      ),
      const SizedBox(height: 8),
      SwitchListTile(
        title: const Text('実行の完了'),
        subtitle: const Text('成功・失敗のどちらも知らせます'),
        value: _notifications.runCompleted,
        onChanged: (v) async {
          await _notifications.setCategory(NotifyCategory.runCompleted, v);
          if (v) await _sink.requestPermission();
          if (mounted) setState(() {});
        },
      ),
      SwitchListTile(
        title: const Text('配布の完了'),
        subtitle: const Text('新しい版の用意・端末への導入・TestFlight 送信'),
        value: _notifications.distribution,
        onChanged: (v) async {
          await _notifications.setCategory(NotifyCategory.distribution, v);
          if (v) await _sink.requestPermission();
          if (mounted) setState(() {});
        },
      ),
      SwitchListTile(
        title: const Text('要対応の発生'),
        subtitle: const Text('人の判断が要る失敗が出たとき'),
        value: _notifications.attention,
        onChanged: (v) async {
          await _notifications.setCategory(NotifyCategory.attention, v);
          if (v) await _sink.requestPermission();
          if (mounted) setState(() {});
        },
      ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: _sendTestNotification,
        icon: const Icon(Icons.notifications_active_outlined),
        label: const Text('テスト通知を送る'),
      ),
    ]);
  }
}
