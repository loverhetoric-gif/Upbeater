import 'package:flutter/material.dart';

import '../core/app_badge_logic.dart';
import '../core/operation_labels.dart';

/// リポジトリ（アプリ）のアイコンバッジ。
/// 名前から決まる色のグラデーション＋頭文字モノグラムで、同じ repo は常に同じ見た目になる。
/// 実行一覧・詳細・履歴・配布・要対応のすべてで repo 表示には必ずこれを付ける
class AppBadge extends StatelessWidget {
  const AppBadge({super.key, required this.repo, this.size = 40});

  /// リポジトリのフルネーム（owner/name）。null や空なら「?」
  final String? repo;
  final double size;

  @override
  Widget build(BuildContext context) {
    final name = repo ?? '';
    final hue = repoHue(name);
    final base = HSLColor.fromAHSL(1, hue, 0.62, 0.42).toColor();
    final deep = HSLColor.fromAHSL(1, (hue + 24) % 360, 0.66, 0.27).toColor();
    final radius = size * 0.28;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [base, deep]),
        border: Border.all(color: Colors.white.withValues(alpha: 0.22), width: 1),
        boxShadow: [BoxShadow(color: deep.withValues(alpha: 0.45), blurRadius: 6, offset: const Offset(0, 2))],
      ),
      alignment: Alignment.center,
      child: Text(
        repoMonogram(name),
        style: TextStyle(color: Colors.white, fontSize: size * 0.38, fontWeight: FontWeight.w700, letterSpacing: 0.5, height: 1),
      ),
    );
  }
}

/// バッジ＋repo 名（短い名前とフルネームの2段）の見出し。repo 表示の標準形
class RepoTitle extends StatelessWidget {
  const RepoTitle({super.key, required this.repo, this.size = 40, this.titleStyle, this.subtitleStyle});
  final String? repo;
  final double size;
  final TextStyle? titleStyle;
  final TextStyle? subtitleStyle;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Row(mainAxisSize: MainAxisSize.min, children: [
      AppBadge(repo: repo, size: size),
      const SizedBox(width: 10),
      Flexible(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(repoDisplayName(repo), style: titleStyle ?? t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
          if (repo != null && repo!.contains('/'))
            Text(repo!, style: subtitleStyle ?? t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onSurfaceVariant), overflow: TextOverflow.ellipsis),
        ]),
      ),
    ]);
  }
}
