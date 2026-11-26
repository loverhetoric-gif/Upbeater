/// 履歴（操作の記録）と実行の表示文言を決める純粋ロジック。
/// kind→ラベル変換、TestFlight 判定、相対時刻・所要時間・日付グループはここに集約し、単体テストする
library;

import 'package:flutter/material.dart';

import 'app_badge_logic.dart';
import 'console_models.dart';

/// 状態の色調（ok・busy・warn・error・attention・neutral）を実際の色へ
Color toneColor(String tone, ColorScheme scheme) => switch (tone) {
      'ok' => const Color(0xFF2FBF71),
      'busy' => const Color(0xFF4C8DFF),
      'warn' => const Color(0xFFF5A623),
      'error' => const Color(0xFFFF5252),
      'attention' => const Color(0xFFFF8A3D),
      _ => scheme.outline,
    };

/// 操作の種類（kind）の日本語ラベル
String operationKindLabel(String kind) => switch (kind) {
      'auto_merge' => '自動マージ',
      'pull_request' => 'プルリクエスト',
      'manual' => '手動実行',
      'release' => '配布の用意',
      'install' => '端末へ導入',
      'run' => '実行',
      'job' => 'ジョブ',
      'push' => 'プッシュ',
      'checks' => 'チェック',
      'schedule' => '定期実行',
      'device' => '端末登録',
      'secret' => '秘密情報',
      'repo' => 'リポジトリ',
      'github' => 'GitHub',
      'commit' => 'コミット',
      'event' => 'イベント',
      'console' => '接続',
      _ => kind,
    };

/// 操作の種類（kind）のアイコン
IconData operationKindIcon(String kind) => switch (kind) {
      'auto_merge' => Icons.merge,
      'pull_request' => Icons.alt_route,
      'manual' => Icons.touch_app_outlined,
      'release' => Icons.rocket_launch_outlined,
      'install' => Icons.install_mobile_outlined,
      'run' => Icons.play_circle_outline,
      'job' => Icons.work_outline,
      'push' => Icons.arrow_upward,
      'checks' => Icons.fact_check_outlined,
      'schedule' => Icons.schedule,
      'device' => Icons.devices_other,
      'secret' => Icons.key_outlined,
      'repo' => Icons.folder_outlined,
      'github' => Icons.code,
      'commit' => Icons.commit,
      'event' => Icons.bolt_outlined,
      'console' => Icons.link,
      _ => Icons.circle_outlined,
    };

/// 実行のきっかけ（event）の日本語ラベル
String runEventLabel(String event) => switch (event) {
      'push' => 'プッシュ',
      'manual' => '手動',
      'workflow_dispatch' => '手動',
      'schedule' => '定期',
      'pull_request' => 'PR',
      'repository_dispatch' => '外部から',
      _ => event,
    };

/// 操作の状態の色調。要対応を最優先で目立たせる
String operationTone(OperationItem o) {
  if (o.needsHuman) return 'attention';
  return switch (o.status) {
    'ok' || 'success' => 'ok',
    'failed' => 'error',
    'retry' => 'warn',
    _ => 'neutral',
  };
}

/// TestFlight 送信に関わる操作かどうか。
/// ワークフロー名（detail.workflow や実行の workflow）・理由文・detail の値に
/// testflight を含むかで判定する（区切り記号と大文字小文字は無視する）
bool isTestFlightRelated({String? workflow, String? reason, Map<String, dynamic>? detail}) {
  bool hit(Object? v) {
    if (v == null) return false;
    final normalized = v.toString().toLowerCase().replaceAll(RegExp(r'[-_\s]'), '');
    return normalized.contains('testflight');
  }

  if (hit(workflow) || hit(reason)) return true;
  if (detail != null) {
    for (final v in detail.values) {
      if (hit(v)) return true;
    }
  }
  return false;
}

/// 履歴の1行の見出し。TestFlight 関係はそれと分かる文言を最優先にする
String operationTitle(OperationItem o) {
  if (isTestFlightRelated(reason: o.reason, detail: o.detail)) return 'TestFlight へ送信';
  return operationKindLabel(o.kind);
}

/// detail から具体的な補足（ワークフロー名・通番・端末・PR 番号など）を1行にまとめる
String operationDetailLine(OperationItem o) {
  final d = o.detail;
  if (d.isEmpty) return '';
  final parts = <String>[];
  final workflow = d['workflow'];
  if (workflow is String && workflow.isNotEmpty) {
    final base = workflow.split('/').last;
    if (!isTestFlightRelated(detail: o.detail)) parts.add(base);
  }
  final platform = d['platform'];
  if (platform is String && platform.isNotEmpty) parts.add(platform);
  final seq = d['seq'];
  if (seq is num) parts.add('通番 ${seq.toInt()}');
  final device = d['device'];
  if (device is String && device.isNotEmpty) parts.add(device);
  final pr = d['pr_number'];
  if (pr is num) parts.add('PR #${pr.toInt()}');
  final build = d['build'] ?? d['build_number'];
  if (build != null) parts.add('ビルド $build');
  final version = d['version'];
  if (version != null) parts.add('版 $version');
  final runner = d['runner'];
  if (runner is String && runner.isNotEmpty) parts.add(runner);
  final conclusion = d['conclusion'];
  if (conclusion is String && conclusion.isNotEmpty) {
    parts.add(switch (conclusion) {
      'success' => '成功',
      'failure' => '失敗',
      'cancelled' => '取り消し',
      _ => conclusion,
    });
  }
  return parts.join('・');
}

/// 相対時刻（例：たった今／3分前／2時間前／昨日／3日前、それより前は日付）
String formatRelative(DateTime? t, {DateTime? now}) {
  if (t == null) return '—';
  final n = now ?? DateTime.now();
  final diff = n.difference(t);
  if (diff.isNegative || diff.inSeconds < 60) return 'たった今';
  if (diff.inMinutes < 60) return '${diff.inMinutes}分前';
  if (diff.inHours < 24 && t.day == n.day && t.month == n.month && t.year == n.year) return '${diff.inHours}時間前';
  final today = DateTime(n.year, n.month, n.day);
  final day = DateTime(t.year, t.month, t.day);
  final days = today.difference(day).inDays;
  if (days == 1) return '昨日';
  if (days < 7) return '$days日前';
  return formatTime(t);
}

/// 所要時間（例：42秒／3分12秒／1時間5分）
String formatDuration(Duration? d) {
  if (d == null) return '—';
  if (d.inSeconds < 60) return '${d.inSeconds}秒';
  if (d.inMinutes < 60) {
    final s = d.inSeconds % 60;
    return s == 0 ? '${d.inMinutes}分' : '${d.inMinutes}分$s秒';
  }
  final m = d.inMinutes % 60;
  return m == 0 ? '${d.inHours}時間' : '${d.inHours}時間$m分';
}

/// 履歴の日付グループの見出し（今日／昨日／M月d日）
String dateGroupLabel(DateTime t, {DateTime? now}) {
  final n = now ?? DateTime.now();
  final today = DateTime(n.year, n.month, n.day);
  final day = DateTime(t.year, t.month, t.day);
  final days = today.difference(day).inDays;
  if (days == 0) return '今日';
  if (days == 1) return '昨日';
  if (t.year == n.year) return '${t.month}月${t.day}日';
  return '${t.year}年${t.month}月${t.day}日';
}

/// 時刻だけ（HH:mm）
String formatClock(DateTime? t) {
  if (t == null) return '—';
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}';
}

/// repo 名の短い表示（バッジ横の見出し用）
String repoDisplayName(String? repo) => repo == null || repo.isEmpty ? '—' : repoShortName(repo);
