import 'package:flutter/material.dart';

/// 管理画面の共通部品。色・言い方は受け手の画面（theme.dart の StatusStyle）に揃える

/// 実行の状態・結果の表示（theme.dart の StatusStyle は受け手の導入状態用なので、こちらは別に持つ）
class RunStatusStyle {
  const RunStatusStyle(this.label, this.icon, this.tone);
  final String label;
  final IconData icon;
  final String tone; // ok・busy・warn・error・neutral

  static RunStatusStyle of(String status, String? conclusion) {
    if (status == 'running') return const RunStatusStyle('実行中', Icons.play_circle_fill, 'busy');
    if (status == 'queued') return const RunStatusStyle('待ち', Icons.schedule, 'warn');
    return switch (conclusion) {
      'success' => const RunStatusStyle('成功', Icons.check_circle, 'ok'),
      'failure' => const RunStatusStyle('失敗', Icons.error_outline, 'error'),
      'definition_error' => const RunStatusStyle('定義の誤り', Icons.error_outline, 'error'),
      'cancelled' => const RunStatusStyle('取り消し', Icons.cancel_outlined, 'neutral'),
      _ => const RunStatusStyle('不明', Icons.help_outline, 'neutral'),
    };
  }

  Color color(ColorScheme s) => switch (tone) {
        'ok' => const Color(0xFF1E8E5A),
        'busy' => s.primary,
        'warn' => const Color(0xFFB7791F),
        'error' => s.error,
        _ => s.outline,
      };
}

/// 読み込み・失敗・未設定の表示つきで一覧画面を作るための土台
class LoadView extends StatelessWidget {
  const LoadView({super.key, required this.loading, required this.error, required this.configured, required this.onRetry, required this.child});
  final bool loading;
  final String? error;
  final bool configured;
  final VoidCallback onRetry;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!configured) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('まだ接続設定がありません。\n「設定」タブで Hub の URL と接続コードを入れてください。', textAlign: TextAlign.center),
        ),
      );
    }
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) {
      final t = Theme.of(context);
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.cloud_off, size: 40, color: t.colorScheme.error),
            const SizedBox(height: 12),
            Text(error!, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.tonal(onPressed: onRetry, child: const Text('もう一度')),
          ]),
        ),
      );
    }
    return child;
  }
}

/// 一覧画面の状態（読み込みと失敗の保持）
mixin Loadable<T extends StatefulWidget> on State<T> {
  bool loading = true;
  String? loadError;

  Future<void> load(Future<void> Function() body) async {
    setState(() {
      loading = true;
      loadError = null;
    });
    try {
      await body();
    } catch (e) {
      if (mounted) setState(() => loadError = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }
}
