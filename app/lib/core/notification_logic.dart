/// 完了通知の差分検出（純粋ロジック）。
/// このプロダクトはプッシュ基盤を持たないため、通知は「前回確認した位置（透かし）」と
/// 最新の実行・操作記録を比べ、新しく完了したものだけを拾う方式にしている。
/// 初回（透かし未設定）は過去分で溢れさせないため、何も出さず透かしだけを現在に合わせる
library;

import 'console_models.dart';
import 'operation_labels.dart';

/// 通知の分類（設定で個別にオン／オフできる）
enum NotifyCategory {
  /// 実行の完了（成功・失敗）
  runCompleted,

  /// 配布（新しい版の用意完了・端末への導入完了・TestFlight 送信）
  distribution,

  /// 要対応（人の判断が要る失敗）の新規発生
  attention,
}

/// 前回確認した位置
class NotifyWatermark {
  const NotifyWatermark({this.initialized = false, this.lastRunUpdatedMs = 0, this.lastOperationId = 0});

  /// 初回のすり合わせが済んだか（false の間は通知を出さない）
  final bool initialized;

  /// 最後に見た実行の updated_at（ミリ秒）
  final int lastRunUpdatedMs;

  /// 最後に見た操作記録の id
  final int lastOperationId;
}

/// 通知すべき1件
class NotifyCandidate {
  const NotifyCandidate({required this.category, required this.notificationId, required this.title, required this.body});
  final NotifyCategory category;

  /// ローカル通知の ID（同じ対象は同じ ID で上書きされる）
  final int notificationId;
  final String title;
  final String body;
}

/// 今回の取得分から次の透かしを作る
NotifyWatermark advanceWatermark(NotifyWatermark prev, List<RunItem> runs, List<OperationItem> operations) {
  var runMs = prev.lastRunUpdatedMs;
  for (final r in runs) {
    final ms = r.updatedAt?.millisecondsSinceEpoch ?? 0;
    if (ms > runMs) runMs = ms;
  }
  var opId = prev.lastOperationId;
  for (final o in operations) {
    if (o.id > opId) opId = o.id;
  }
  return NotifyWatermark(initialized: true, lastRunUpdatedMs: runMs, lastOperationId: opId);
}

/// 透かしより新しい完了・配布・要対応を通知候補として拾う。
/// [enabled] に含まれない分類は出さない。初回（未初期化）は常に空
List<NotifyCandidate> detectNotifications({
  required List<RunItem> runs,
  required List<OperationItem> operations,
  required NotifyWatermark watermark,
  required Set<NotifyCategory> enabled,
}) {
  if (!watermark.initialized) return const [];
  final out = <NotifyCandidate>[];

  // 実行の完了（透かし後に更新され、完了しているもの）
  if (enabled.contains(NotifyCategory.runCompleted)) {
    for (final r in runs) {
      final ms = r.updatedAt?.millisecondsSinceEpoch ?? 0;
      if (ms <= watermark.lastRunUpdatedMs || r.status != 'completed') continue;
      final name = repoDisplayName(r.repo);
      final testFlight = isTestFlightRelated(workflow: r.workflow);
      final result = switch (r.conclusion) {
        'success' => '成功',
        'failure' => '失敗',
        'definition_error' => '定義の誤りで失敗',
        'cancelled' => '取り消し',
        _ => '完了',
      };
      out.add(NotifyCandidate(
        category: NotifyCategory.runCompleted,
        notificationId: 100000 + (r.runId.hashCode & 0x3fffffff),
        title: testFlight ? '$name：TestFlight 送信 #${r.number} が$result' : '$name：実行 #${r.number} が$result',
        body: '${r.workflow}・${runEventLabel(r.event)}・${r.branch}',
      ));
    }
  }

  for (final o in operations) {
    if (o.id <= watermark.lastOperationId) continue;
    final name = repoDisplayName(o.repo);

    // 要対応の新規発生
    if (o.needsHuman && enabled.contains(NotifyCategory.attention)) {
      out.add(NotifyCandidate(
        category: NotifyCategory.attention,
        notificationId: 200000 + o.id,
        title: '$name：要対応が発生しました',
        body: o.reason ?? '${operationKindLabel(o.kind)}／${o.stage}',
      ));
      continue;
    }

    if (!enabled.contains(NotifyCategory.distribution)) continue;

    // 新しい版の用意ができた
    if (o.kind == 'release' && o.stage == 'ready' && o.status == 'ok') {
      final line = operationDetailLine(o);
      out.add(NotifyCandidate(
        category: NotifyCategory.distribution,
        notificationId: 300000 + o.id,
        title: '$name：新しい版の用意ができました',
        body: line.isEmpty ? '配布できる状態になりました' : line,
      ));
      continue;
    }

    // 端末への導入が終わった
    if (o.kind == 'install' && o.status == 'ok') {
      final line = operationDetailLine(o);
      out.add(NotifyCandidate(
        category: NotifyCategory.distribution,
        notificationId: 400000 + o.id,
        title: '$name：端末への導入が完了しました',
        body: line.isEmpty ? (o.reason ?? '導入が完了しました') : line,
      ));
      continue;
    }

    // TestFlight 送信の完了（実行の完了通知と重なる場合は実行側を優先し、こちらは記録ベースの補完）
    if (o.kind == 'run' && o.stage == 'completed' && o.status == 'ok' && isTestFlightRelated(detail: o.detail)) {
      out.add(NotifyCandidate(
        category: NotifyCategory.distribution,
        notificationId: 500000 + o.id,
        title: '$name：TestFlight へ送信しました',
        body: o.reason ?? 'TestFlight への送信が完了しました',
      ));
    }
  }
  return out;
}
