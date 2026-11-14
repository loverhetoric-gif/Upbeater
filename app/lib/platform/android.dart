/// Android：PackageInstaller のセッションで導入する（ネイティブ側は MainActivity.kt）
/// Android 12 以降、Upbeater がそのアプリの導入元であれば確認なしで更新できる
library;

import 'dart:io';

import 'package:flutter/services.dart';

import '../core/manifest.dart';
import '../core/platform.dart';

class AndroidInstaller implements Installer {
  AndroidInstaller({MethodChannel? channel}) : _ch = channel ?? const MethodChannel('upbeater/android');
  final MethodChannel _ch;
  bool _guided = false;

  @override
  String get os => 'android';

  /// Android は版（versionCode）を下げられないため、ひとつ前の版への入れ直しはできない。
  /// 導入の失敗は OS が元の版のまま残すので、端末は壊れない
  @override
  bool get canRestore => false;

  @override
  Future<String?> preflight() async {
    final ok = await _ch.invokeMethod<bool>('canInstall') ?? false;
    if (ok) return null;
    // 案内は一度だけ（設定の画面を開く）
    if (!_guided) {
      _guided = true;
      await _ch.invokeMethod<void>('openInstallSettings');
    }
    return '「不明なアプリのインストール」を Upbeater に許可してください';
  }

  @override
  Future<String?> deferIfRunning(ManifestBody body) async => null; // 使用中のアプリは OS が終了させて更新する

  Future<Map<String, dynamic>?> _info(String method, Map<String, dynamic> args) async {
    final r = await _ch.invokeMethod<Map<Object?, Object?>>(method, args);
    return r?.map((k, v) => MapEntry(k as String, v));
  }

  @override
  Future<InstallResult> install(File artifact, ManifestBody body) async {
    final apk = await _info('archiveInfo', {'path': artifact.path});
    if (apk == null) return const InstallResult.failed('APK として読めません');
    final pkg = apk['package'] as String;
    final expected = body.installString('package');
    if (expected != null && expected != pkg) return InstallResult.failed('パッケージ名が一致しません（期待 $expected、実際 $pkg）');

    final installed = await _info('installedInfo', {'package': pkg});
    if (installed != null) {
      // 同じ署名鍵でなければ導入しない（利用者データを守るため。OS も拒否する）
      final a = Set<String>.from(apk['signers'] as List);
      final b = Set<String>.from(installed['signers'] as List);
      if (a.intersection(b).isEmpty) return const InstallResult.failed('署名鍵が導入済みの版と異なるため、導入しません');
      // この成果物そのものがすでに入っている：導入済みとして扱う
      // （Upbeater 自身の更新でアプリが入れ替え中に終了した後や、最初の 1 回を Mac から入れた後）
      final current = await _ch.invokeMethod<String>('installedSha256', {'package': pkg});
      if (current != null && current.toLowerCase() == body.sha256.toLowerCase()) return const InstallResult.ok('すでに導入済みです');
      if ((installed['versionCode'] as num) >= (apk['versionCode'] as num)) {
        return InstallResult.failed('versionCode が上がっていません（導入済み ${installed['versionCode']}、新しい版 ${apk['versionCode']}）');
      }
    }
    final r = await _info('install', {'path': artifact.path});
    return switch (r?['status']) {
      'success' => const InstallResult.ok(),
      'pending_user_action' => const InstallResult.deferred('導入の確認を待っています'),
      _ => InstallResult.failed((r?['message'] as String?) ?? '導入に失敗しました'),
    };
  }

  @override
  Future<bool> healthCheck(ManifestBody body) async {
    final pkg = body.installString('package');
    if (pkg == null) return true;
    return await _info('installedInfo', {'package': pkg}) != null;
  }

  @override
  Future<InstallResult> restore(File artifact, Map<String, dynamic> install) async => const InstallResult.failed('Android では前の版に戻せません');
}

class AndroidDiskSpace implements DiskSpace {
  AndroidDiskSpace({MethodChannel? channel}) : _ch = channel ?? const MethodChannel('upbeater/android');
  final MethodChannel _ch;
  @override
  Future<int?> freeBytes(Directory dir) async => (await _ch.invokeMethod<num>('freeBytes', {'path': dir.path}))?.toInt();
}
