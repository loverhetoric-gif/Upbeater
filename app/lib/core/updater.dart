/// 更新の手順（照合 → 検証 → 事前確認 → 取得 → 照合 → 導入 → 起動の確認 → 報告）。
/// どの段階で失敗しても、端末には動く版が残るようにする。
library;

import 'dart:io';

import 'downloader.dart';
import 'hub_client.dart';
import 'manifest.dart';
import 'platform.dart';
import 'state.dart';

enum Outcome { upToDate, installed, rolledBack, deferred, failed, rejected, skipped, hubUnreachable }

class Updater {
  Updater({
    required this.hub,
    required this.store,
    required this.state,
    required this.keys,
    required this.installer,
    required this.disk,
    required this.network,
    required this.versionsDir,
    Downloader? downloader,
    DateTime Function()? clock,
  })  : downloader = downloader ?? Downloader(),
        _now = clock ?? DateTime.now;

  final HubClient hub;
  final StateStore store;
  final DeviceState state;
  TrustedKeys keys;
  final Installer installer;
  final DiskSpace disk;
  final NetworkPolicy network;
  final Directory versionsDir;
  final Downloader downloader;
  final DateTime Function() _now;

  /// 同じ版の検証の失敗がこの回数に達したら、その版は試さない（Hub 側でも配信を止める）
  static const maxFailuresPerSeq = 2;

  /// 導入に必要な空き容量の目安（成果物・展開・ひとつ前の版の保持）
  static int requiredSpace(int size) => size * 3 + 50 * 1024 * 1024;

  bool _running = false;

  /// 全アプリを照合する。同時に二重に走らせない
  Future<Map<String, Outcome>> checkAll() async {
    if (_running) return {};
    _running = true;
    try {
      final out = <String, Outcome>{};
      List<RemoteApp> apps;
      try {
        apps = await hub.apps();
      } on HubException {
        // Hub が止まっていても、端末は現行版のまま動き続ける
        return {for (final id in state.apps.keys) id: Outcome.hubUnreachable};
      }
      for (final a in apps) {
        state.app(a.appId).name = a.name;
        out[a.appId] = await checkApp(a.appId);
      }
      state.lastCheckAt = _now().millisecondsSinceEpoch;
      await store.save(state);
      return out;
    } finally {
      _running = false;
    }
  }

  Future<void> _set(AppState s, String status, [String? message]) async {
    s.status = status;
    s.message = message;
    s.updatedAt = _now().millisecondsSinceEpoch;
    await store.save(state);
  }

  Future<void> _report(String appId, int seq, String status, {String? message, String? stage}) async {
    try {
      await hub.report(appId, seq, status, message: message, stage: stage);
    } on HubException {
      // 報告できなくても更新の結果は変わらない（次の照合で状態は揃う）
    }
  }

  Future<Outcome> checkApp(String appId) async {
    final s = state.app(appId);
    CheckResponse check;
    try {
      check = await hub.check(appId, s.currentSeq);
    } on HubException {
      return Outcome.hubUnreachable;
    }
    keys = keys.withRevoked(check.revokedGenerations);
    if (!check.update || check.manifest == null) {
      if (s.status != 'deferred' && s.status != 'failed') await _set(s, 'up_to_date');
      return Outcome.upToDate;
    }
    return _apply(appId, s, check.manifest!);
  }

  Future<Outcome> _apply(String appId, AppState s, SignedManifest signed, {bool urlRetried = false}) async {
    if (keys.isEmpty) {
      await _set(s, 'rejected', '検証用の公開鍵が埋め込まれていません');
      return Outcome.rejected;
    }
    final r = await acceptManifest(signed, keys, appId: appId, os: installer.os, currentSeq: s.currentSeq, nowMs: _now().millisecondsSinceEpoch);
    if (r is ManifestRejected) {
      if (r.reason == 'same_version') return Outcome.upToDate;
      await _set(s, 'rejected', 'マニフェストを受け入れませんでした（${r.reason}）');
      await _report(appId, s.currentSeq, 'failed', stage: 'verify_manifest', message: 'マニフェストを拒否：${r.reason}');
      return Outcome.rejected;
    }
    final body = (r as ManifestAccepted).body;
    if ((s.failures[body.seq] ?? 0) >= maxFailuresPerSeq) return Outcome.skipped;

    // 事前確認：導入の許可・回線・空き容量・使用中
    final pre = await installer.preflight();
    if (pre != null) return _defer(appId, s, body, 'permission', pre);
    if (state.wifiOnly && !await network.isUnmetered()) return _defer(appId, s, body, 'network', 'Wi-Fi に接続するまで取得を待ちます');
    final free = await disk.freeBytes(versionsDir);
    final need = requiredSpace(body.size);
    if (free != null && free < need) {
      return _defer(appId, s, body, 'disk_space', '空き容量が足りません（必要 ${_mb(need)}、空き ${_mb(free)}）');
    }
    final running = await installer.deferIfRunning(body);
    if (running != null) return _defer(appId, s, body, 'app_running', running);

    // 取得：保持している同じ成果物があれば使う。中断しても続きから
    await _set(s, 'downloading', '通番 ${body.seq} を取得しています');
    await _report(appId, body.seq, 'downloading');
    final dest = File('${versionsDir.path}/$appId/${body.seq}-${body.sha256.substring(0, 16)}.bin');
    File file;
    try {
      file = await downloader.download(Uri.parse(body.url), dest, expectedSha256: body.sha256, expectedSize: body.size);
    } on UrlRejectedException {
      // URL の期限切れ：照合し直して新しい URL で続きから取る（一度だけ）
      if (urlRetried) return _fail(appId, s, body, 'download', '成果物の URL が受け付けられませんでした');
      try {
        final again = await hub.check(appId, s.currentSeq);
        if (again.manifest == null) return Outcome.upToDate;
        return await _apply(appId, s, again.manifest!, urlRetried: true);
      } on HubException {
        return Outcome.hubUnreachable;
      }
    } on IntegrityException catch (e) {
      s.failures[body.seq] = (s.failures[body.seq] ?? 0) + 1;
      return _fail(appId, s, body, 'verifying', '成果物の照合に失敗しました（${e.message}）');
    } on DownloadException catch (e) {
      return _fail(appId, s, body, 'download', e.message);
    }

    // 導入
    await _set(s, 'installing', '通番 ${body.seq} を導入しています');
    await _report(appId, body.seq, 'installing');
    InstallResult result;
    try {
      result = await installer.install(file, body);
    } catch (e) {
      result = InstallResult.failed('$e');
    }
    if (result.deferred) return _defer(appId, s, body, 'app_running', result.message ?? '導入を保留しました');
    if (!result.ok) {
      s.failures[body.seq] = (s.failures[body.seq] ?? 0) + 1;
      return _restoreOrFail(appId, s, body, '導入に失敗しました：${result.message ?? '理由不明'}');
    }

    // 起動の確認。できなければ戻し、その版は二度と試さない
    var healthy = false;
    try {
      healthy = await installer.healthCheck(body);
    } catch (_) {}
    if (!healthy) {
      s.failures[body.seq] = maxFailuresPerSeq;
      return _restoreOrFail(appId, s, body, '入れ替え後の起動を確認できませんでした');
    }

    // 成功：直近 2 つの版を保持し、それより古いものは消す
    final kept = [KeptVersion(seq: body.seq, sha256: body.sha256, file: file.path, commitSha: body.commitSha, install: body.install), ...s.kept.where((k) => k.seq != body.seq)];
    for (final old in kept.skip(2)) {
      final f = File(old.file);
      if (await f.exists()) await f.delete();
    }
    s.kept = kept.take(2).toList();
    s.currentSeq = body.seq;
    s.failures.remove(body.seq);
    await _set(s, 'installed', body.rollbackToSeq != null ? '通番 ${body.seq} に戻しました（巻き戻しの指示）' : '通番 ${body.seq} を導入しました');
    await _report(appId, body.seq, 'installed', stage: body.rollbackToSeq != null ? 'rollback' : 'installed');
    return Outcome.installed;
  }

  Future<Outcome> _defer(String appId, AppState s, ManifestBody body, String stage, String message) async {
    await _set(s, 'deferred', message);
    await _report(appId, body.seq, 'deferred', stage: stage, message: message);
    return Outcome.deferred;
  }

  Future<Outcome> _fail(String appId, AppState s, ManifestBody body, String stage, String message) async {
    await _set(s, 'failed', message);
    await _report(appId, body.seq, 'failed', stage: stage, message: message);
    return Outcome.failed;
  }

  /// 失敗したら、保持しているひとつ前の版（いま動いていた版）に戻す
  Future<Outcome> _restoreOrFail(String appId, AppState s, ManifestBody body, String reason) async {
    final previous = s.kept.isEmpty ? null : s.kept.first;
    if (previous != null && installer.canRestore && await File(previous.file).exists()) {
      InstallResult r;
      try {
        r = await installer.restore(File(previous.file), previous.install);
      } catch (e) {
        r = InstallResult.failed('$e');
      }
      if (r.ok) {
        await _set(s, 'rolled_back', '$reason。通番 ${previous.seq} に戻しました');
        await _report(appId, previous.seq, 'rolled_back', stage: 'restore', message: '通番 ${body.seq}：$reason');
        return Outcome.rolledBack;
      }
      await _set(s, 'failed', '$reason。戻す処理も失敗しました：${r.message}');
      await _report(appId, body.seq, 'failed', stage: 'restore', message: '$reason／戻す処理も失敗：${r.message}');
      return Outcome.failed;
    }
    return _fail(appId, s, body, 'install', reason);
  }

  static String _mb(int bytes) => '${(bytes / (1024 * 1024)).toStringAsFixed(0)} MB';
}
