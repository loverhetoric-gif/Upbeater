import 'package:flutter/material.dart';

import '../console_service.dart';

/// 管理の設定：Hub の URL と接続用トークン（upb_m_）。
/// トークンの発行は管理 API（POST /v1/admin/mcp-tokens、ADMIN_TOKEN が必要）で行う。
/// アプリ内 OAuth は Hub のリダイレクト検証が https のみのため未対応で、その旨もここに出す
class ConsoleSettingsScreen extends StatefulWidget {
  const ConsoleSettingsScreen({super.key, required this.service});
  final ConsoleService service;

  @override
  State<ConsoleSettingsScreen> createState() => _ConsoleSettingsScreenState();
}

class _ConsoleSettingsScreenState extends State<ConsoleSettingsScreen> {
  late final _url = TextEditingController(text: widget.service.hubUrl);
  late final _token = TextEditingController(text: widget.service.token);
  bool _busy = false;
  String? _message;
  bool _messageIsError = false;

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _saveAndTest() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await widget.service.saveSettings(hubUrl: _url.text, token: _token.text);
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
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Hub への接続', style: t.textTheme.titleMedium),
      const SizedBox(height: 12),
      TextField(
        controller: _url,
        keyboardType: TextInputType.url,
        autocorrect: false,
        decoration: const InputDecoration(labelText: 'Hub の URL', hintText: 'https://upbeater.loverhetoric.com'),
      ),
      const SizedBox(height: 12),
      TextField(
        controller: _token,
        autocorrect: false,
        obscureText: true,
        decoration: const InputDecoration(labelText: '接続用トークン（upb_m_）', hintText: 'upb_m_...'),
      ),
      const SizedBox(height: 8),
      Text(
        'トークンは端末の安全な保管場所に保存されます。発行は Hub の管理 API（POST /v1/admin/mcp-tokens）で、名前を付けて行ってください。',
        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant),
      ),
      const SizedBox(height: 16),
      FilledButton.icon(
        onPressed: _busy ? null : _saveAndTest,
        icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2)) : const Icon(Icons.link),
        label: const Text('保存して接続を確認'),
      ),
      if (_message != null) ...[
        const SizedBox(height: 12),
        Text(_message!, style: TextStyle(color: _messageIsError ? t.colorScheme.error : const Color(0xFF1E8E5A))),
      ],
      const SizedBox(height: 24),
      if (widget.service.configured)
        OutlinedButton.icon(
          onPressed: () async {
            await widget.service.clearToken();
            _token.clear();
            if (mounted) {
              setState(() {
                _message = 'トークンを消しました';
                _messageIsError = false;
              });
            }
          },
          icon: const Icon(Icons.delete_outline),
          label: const Text('トークンを消す'),
        ),
    ]);
  }
}
