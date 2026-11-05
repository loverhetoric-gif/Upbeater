import 'package:flutter/material.dart';

import '../app_service.dart';
import '../core/hub_client.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key, required this.service, this.defaultName = ''});
  final AppService service;
  final String defaultName;

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _form = GlobalKey<FormState>();
  late final _hub = TextEditingController();
  late final _code = TextEditingController();
  late final _name = TextEditingController(text: widget.defaultName);
  bool _sending = false;
  String? _error;

  @override
  void dispose() {
    _hub.dispose();
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await widget.service.register(hubUrl: _hub.text, code: _code.text, name: _name.text);
    } on HubException catch (e) {
      setState(() => _error = e.status == 400 ? '登録コードが無効か、期限切れか、使用済みです' : e.message);
    } catch (e) {
      setState(() => _error = '登録できませんでした：$e');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
                  child: Form(
                    key: _form,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(children: [
                          Container(
                            width: 32,
                            height: 32,
                            decoration: BoxDecoration(color: t.colorScheme.primary, borderRadius: BorderRadius.circular(9)),
                            alignment: Alignment.center,
                            child: Text('U', style: TextStyle(color: t.colorScheme.onPrimary, fontWeight: FontWeight.w800)),
                          ),
                          const SizedBox(width: 10),
                          Text('Upbeater', style: t.textTheme.titleMedium?.copyWith(color: t.colorScheme.onSurfaceVariant, fontWeight: FontWeight.w600)),
                        ]),
                        const SizedBox(height: 20),
                        Text('端末を登録', style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                        const SizedBox(height: 6),
                        Text('Claude で発行した登録コードを入力してください。コードは一回限りで、15 分で失効します。',
                            style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                        const SizedBox(height: 24),
                        TextFormField(
                          controller: _hub,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          decoration: const InputDecoration(labelText: 'Hub のアドレス', hintText: 'https://…'),
                          validator: (v) {
                            final u = Uri.tryParse(v?.trim() ?? '');
                            if (u == null || u.scheme != 'https' || u.host.isEmpty) return 'https で始まるアドレスを入力してください';
                            return null;
                          },
                        ),
                        const SizedBox(height: 14),
                        TextFormField(
                          controller: _code,
                          textCapitalization: TextCapitalization.characters,
                          autocorrect: false,
                          decoration: const InputDecoration(labelText: '登録コード', hintText: 'XXXXX-XXXXX'),
                          validator: (v) => (v ?? '').replaceAll(RegExp(r'[\s-]'), '').length == 10 ? null : '10 文字のコードを入力してください',
                        ),
                        const SizedBox(height: 14),
                        TextFormField(
                          controller: _name,
                          decoration: const InputDecoration(labelText: '端末の名前', hintText: '例：仕事用の MacBook'),
                          validator: (v) => (v ?? '').trim().isEmpty ? '名前を入力してください' : null,
                        ),
                        if (_error != null) ...[
                          const SizedBox(height: 14),
                          Text(_error!, style: TextStyle(color: t.colorScheme.error)),
                        ],
                        const SizedBox(height: 22),
                        FilledButton(
                          onPressed: _sending ? null : _submit,
                          child: _sending
                              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.4))
                              : const Text('登録する'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
