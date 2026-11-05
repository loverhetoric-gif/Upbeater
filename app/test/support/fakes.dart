import 'dart:io';

import 'package:upbeater/core/manifest.dart';
import 'package:upbeater/core/platform.dart';

class FakeInstaller implements Installer {
  FakeInstaller({this.restorable = true});
  final bool restorable;
  final installed = <int>[];
  final restored = <String>[];
  bool failNext = false;
  bool unhealthy = false;
  String? runningMessage;
  String? permissionMessage;

  @override
  String get os => 'macos';
  @override
  bool get canRestore => restorable;
  @override
  Future<String?> preflight() async => permissionMessage;
  @override
  Future<String?> deferIfRunning(ManifestBody body) async => runningMessage;
  @override
  Future<InstallResult> install(File artifact, ManifestBody body) async {
    if (failNext) {
      failNext = false;
      return const InstallResult.failed('模擬の導入失敗');
    }
    installed.add(body.seq);
    return const InstallResult.ok();
  }

  @override
  Future<bool> healthCheck(ManifestBody body) async => !unhealthy;
  @override
  Future<InstallResult> restore(File artifact, Map<String, dynamic> install) async {
    restored.add(artifact.path);
    return const InstallResult.ok();
  }
}

class FakeDisk implements DiskSpace {
  int? free;
  @override
  Future<int?> freeBytes(Directory dir) async => free;
}

class FakeNetwork implements NetworkPolicy {
  bool unmetered = true;
  @override
  Future<bool> isUnmetered() async => unmetered;
}
