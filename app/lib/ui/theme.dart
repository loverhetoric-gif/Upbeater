import 'package:flutter/material.dart';

const _seed = Color(0xFF2F5BEA);

ThemeData buildTheme(Brightness b) {
  // fidelity：指定した色をそのまま主要色に使う（同意の画面と同じ青）
  final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: b, dynamicSchemeVariant: DynamicSchemeVariant.fidelity);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: b == Brightness.light ? const Color(0xFFF4F5F7) : const Color(0xFF0F1115),
    cardTheme: CardThemeData(
      elevation: 0,
      color: scheme.surfaceContainerLowest,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: scheme.outlineVariant)),
      margin: EdgeInsets.zero,
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      filled: true,
      fillColor: scheme.surfaceContainerLow,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(minimumSize: const Size(0, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
    ),
  );
}

/// 状態ごとの表示（短く、分析向けの言い方にする）
class StatusStyle {
  const StatusStyle(this.label, this.icon, this.tone);
  final String label;
  final IconData icon;

  /// ok・busy・warn・error・neutral
  final String tone;

  static StatusStyle of(String status) => switch (status) {
        'up_to_date' => const StatusStyle('最新', Icons.check_circle_outline, 'ok'),
        'installed' => const StatusStyle('導入済み', Icons.check_circle, 'ok'),
        'downloading' => const StatusStyle('取得中', Icons.downloading, 'busy'),
        'installing' => const StatusStyle('導入中', Icons.install_desktop, 'busy'),
        'deferred' => const StatusStyle('保留', Icons.schedule, 'warn'),
        'rolled_back' => const StatusStyle('復元済み', Icons.restore, 'warn'),
        'failed' => const StatusStyle('失敗', Icons.error_outline, 'error'),
        'rejected' => const StatusStyle('拒否', Icons.gpp_bad_outlined, 'error'),
        _ => const StatusStyle('未照合', Icons.radio_button_unchecked, 'neutral'),
      };

  /// 並べる順（人の判断が要るものを先に）
  int get priority => switch (tone) {
        'error' => 0,
        'warn' => 1,
        'busy' => 2,
        _ => 3,
      };

  Color color(ColorScheme s) => switch (tone) {
        'ok' => const Color(0xFF1E8E5A),
        'busy' => s.primary,
        'warn' => const Color(0xFFB7791F),
        'error' => s.error,
        _ => s.outline,
      };
}
