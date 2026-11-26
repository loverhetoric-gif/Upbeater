import 'package:flutter/material.dart';

import '../console_service.dart';

/// 管理の設定：Hub の URL と接続コード（一回限り・15 分）。
/// コードは Claude（MCP の道具 create_console_code）か管理 API で発行する。
/// 引き換えで得た接続の控えは端末の安全な保管場所に保存され、画面には出ない
class ConsoleSettingsScreen extends StatefulWidget {
  const ConsoleSettingsScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleSettingsScreen> createState() => _ConsoleSettingsScreenState();
}

class _ConsoleSettingsScreenState extends State<ConsoleSettingsScreen> {
  late final _url = TextEditingController(text: widget.service.hubUrl);
  final _code = TextEditingController();
  bool _busy = false;
  String? _message;
  bool _messageIsError = false;

  @override
  void dispose() {
    _url.dispose();
    _code.dispose();
    super.dispose();
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
    ]);
  }
}
