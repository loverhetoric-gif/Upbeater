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

/// 管理画面（コンソール）専用のテーマ。ダーク基調で作り込む：
/// 深い背景に一段浮いたカード、細い境界線、状態色は彩度を上げて暗所でも読めるようにする
ThemeData buildConsoleTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: Brightness.dark, dynamicSchemeVariant: DynamicSchemeVariant.fidelity).copyWith(
    surface: const Color(0xFF12161E),
    surfaceContainerLowest: const Color(0xFF171C26),
    surfaceContainerLow: const Color(0xFF1B212E),
    surfaceContainer: const Color(0xFF202836),
    onSurface: const Color(0xFFF2F4F8),
    onSurfaceVariant: const Color(0xFFA7B0C0),
    outline: const Color(0xFF3A4356),
    outlineVariant: const Color(0xFF262E3D),
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: const Color(0xFF0C0F14),
    appBarTheme: AppBarTheme(backgroundColor: const Color(0xFF0C0F14), foregroundColor: scheme.onSurface, elevation: 0, scrolledUnderElevation: 0),
    cardTheme: CardThemeData(
      elevation: 0,
      color: scheme.surfaceContainerLowest,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: scheme.outlineVariant)),
      margin: EdgeInsets.zero,
    ),
    chipTheme: ChipThemeData(
      backgroundColor: scheme.surfaceContainerLow,
      selectedColor: scheme.primaryContainer,
      side: BorderSide(color: scheme.outlineVariant),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      labelStyle: TextStyle(color: scheme.onSurface, fontSize: 13),
      secondaryLabelStyle: TextStyle(color: scheme.onPrimaryContainer, fontSize: 13),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: const Color(0xFF10141B),
      indicatorColor: scheme.primaryContainer,
      labelTextStyle: WidgetStatePropertyAll(TextStyle(fontSize: 11, color: scheme.onSurface)),
      iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(color: states.contains(WidgetState.selected) ? scheme.onPrimaryContainer : scheme.onSurfaceVariant)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      filled: true,
      fillColor: scheme.surfaceContainerLow,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(minimumSize: const Size(0, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
    ),
    dividerTheme: DividerThemeData(color: scheme.outlineVariant, thickness: 1, space: 1),
    listTileTheme: const ListTileThemeData(iconColor: Color(0xFFA7B0C0)),
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
