/// OS ごとに差し替える部品の抽象（導入方法・空き容量・通信の種類）
library;

import 'dart:io';

import 'manifest.dart';

class InstallResult {
  const InstallResult.ok([this.message]) : ok = true, deferred = false;
  const InstallResult.failed(this.message) : ok = false, deferred = false;
  const InstallResult.deferred(this.message) : ok = false, deferred = true;
  final bool ok;
  final bool deferred;
  final String? message;
}

abstract class Installer {
  String get os;

  /// 導入できる状態か（Android の「不明なアプリのインストール」の許可など）。できなければ理由
  Future<String?> preflight();

  /// 対象アプリが使用中で、設定により今は入れ替えない場合は理由を返す
  Future<String?> deferIfRunning(ManifestBody body);

  Future<InstallResult> install(File artifact, ManifestBody body);

  /// 入れ替え後に起動できるかを確かめる
  Future<bool> healthCheck(ManifestBody body);

  /// 保持しているひとつ前の版に戻せるか（Android は版を下げられないため false）
  bool get canRestore;

  Future<InstallResult> restore(File artifact, Map<String, dynamic> install);
}

abstract class DiskSpace {
  Future<int?> freeBytes(Directory dir);
}

abstract class NetworkPolicy {
  /// 従量制でない回線（Wi-Fi・有線）につながっているか
  Future<bool> isUnmetered();
}
