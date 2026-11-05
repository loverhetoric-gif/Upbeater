/// macOS：取得した .app を検証して /Applications 内を差し替え、隔離属性を外して起動を確かめる
library;

import 'dart:async';
import 'dart:io';

import '../core/manifest.dart';
import '../core/platform.dart';

typedef ProcessRunner = Future<ProcessResult> Function(String executable, List<String> arguments);

Future<ProcessResult> _defaultRunner(String exe, List<String> args) => Process.run(exe, args);

class MacosInstaller implements Installer {
  MacosInstaller({
    required this.workDir,
    this.applicationsDir = '/Applications',
    this.selfBundleId = 'com.upbeater.upbeater',
    ProcessRunner? run,
    Future<void> Function(Duration)? sleep,
    this.onSelfUpdate,
  })  : _run = run ?? _defaultRunner,
        _sleep = sleep ?? Future<void>.delayed;

  final Directory workDir;
  final String applicationsDir;
  final String selfBundleId;
  final ProcessRunner _run;
  final Future<void> Function(Duration) _sleep;

  /// Upbeater 自身の更新を別プロセスに任せた後に呼ばれる（アプリを終了させる）
  final void Function()? onSelfUpdate;

  @override
  String get os => 'macos';

  @override
  bool get canRestore => true;

  @override
  Future<String?> preflight() async {
    final probe = File('$applicationsDir/.upbeater-write-test');
    try {
      await probe.writeAsString('');
      await probe.delete();
      return null;
    } catch (_) {
      return '$applicationsDir に書き込めません（管理者の権限が必要です）';
    }
  }

  String? _bundle(Map<String, dynamic> install) => install['bundle'] is String ? install['bundle'] as String : null;
  String _policy(Map<String, dynamic> install) => install['when_running'] is String ? install['when_running'] as String : 'wait';

  Future<bool> _isRunning(String bundle) async {
    final r = await _run('/usr/bin/pgrep', ['-f', '$applicationsDir/$bundle/Contents/MacOS/']);
    return r.exitCode == 0;
  }

  @override
  Future<String?> deferIfRunning(ManifestBody body) async {
    final bundle = _bundle(body.install);
    if (bundle == null || !await _isRunning(bundle)) return null;
    return switch (_policy(body.install)) {
      'restart' => null,
      'next_launch' => '使用中のため、次に終了した後に入れ替えます',
      _ => '使用中のため、終了を待って入れ替えます',
    };
  }

  @override
  Future<InstallResult> install(File artifact, ManifestBody body) => _installArchive(artifact, body.install);

  @override
  Future<InstallResult> restore(File artifact, Map<String, dynamic> install) async {
    final r = await _installArchive(artifact, install, isRestore: true);
    final bundle = _bundle(install);
    if (r.ok && bundle != null) await _run('/usr/bin/open', ['$applicationsDir/$bundle']);
    return r;
  }

  @override
  Future<bool> healthCheck(ManifestBody body) async {
    final bundle = _bundle(body.install);
    if (bundle == null) return true;
    final seconds = body.install['health_seconds'] is num ? (body.install['health_seconds'] as num).toInt() : 15;
    if (seconds <= 0) return true;
    final open = await _run('/usr/bin/open', ['$applicationsDir/$bundle']);
    if (open.exitCode != 0) return false;
    await _sleep(Duration(seconds: seconds));
    return _isRunning(bundle);
  }

  Future<InstallResult> _installArchive(File artifact, Map<String, dynamic> install, {bool isRestore = false}) async {
    await workDir.create(recursive: true);
    final staging = await workDir.createTemp('staging-');
    try {
      final x = await _run('/usr/bin/tar', ['-xzf', artifact.path, '-C', staging.path]);
      if (x.exitCode != 0) return InstallResult.failed('成果物を展開できません：${x.stderr}');

      var bundle = _bundle(install);
      if (bundle == null) {
        final apps = staging.listSync().whereType<Directory>().where((d) => d.path.endsWith('.app')).toList();
        if (apps.length != 1) return const InstallResult.failed('成果物の中に .app がひとつだけ含まれている必要があります');
        bundle = apps.single.uri.pathSegments.where((s) => s.isNotEmpty).last;
      }
      if (bundle.contains('/') || !bundle.endsWith('.app')) return InstallResult.failed('bundle の指定が正しくありません：$bundle');
      final staged = Directory('${staging.path}/$bundle');
      if (!await staged.exists()) return InstallResult.failed('成果物に $bundle がありません');

      // バンドル ID が違うものは入れない（別のアプリによる上書き・利用者データの取り違えを防ぐ）
      final id = await _bundleId(staged);
      final expected = install['bundle_id'] is String ? install['bundle_id'] as String : null;
      if (expected != null && id != expected) return InstallResult.failed('バンドル ID が一致しません（期待 $expected、実際 ${id ?? '不明'}）');

      if (id == selfBundleId && !isRestore) return await _selfUpdate(staged, bundle);

      if (await _isRunning(bundle)) {
        if (_policy(install) != 'restart' && !isRestore) return const InstallResult.deferred('使用中のため、終了を待って入れ替えます');
        await _quit(bundle, id);
      }

      final target = Directory('$applicationsDir/$bundle');
      final old = Directory('$applicationsDir/$bundle.upbeater-old');
      if (await old.exists()) await old.delete(recursive: true);
      final hadOld = await target.exists();
      if (hadOld) await target.rename(old.path);
      try {
        await _move(staged, target);
      } catch (e) {
        // 入れ替えに失敗：元の版を戻す
        if (await target.exists()) await target.delete(recursive: true);
        if (hadOld) await old.rename(target.path);
        return InstallResult.failed('入れ替えに失敗しました：$e');
      }
      await _run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', target.path]);
      if (hadOld) await old.delete(recursive: true);
      return const InstallResult.ok();
    } finally {
      if (await staging.exists()) await staging.delete(recursive: true);
    }
  }

  Future<void> _move(Directory from, Directory to) async {
    try {
      await from.rename(to.path);
    } on FileSystemException {
      // 別のボリュームをまたぐ場合は複製する
      final r = await _run('/usr/bin/ditto', [from.path, to.path]);
      if (r.exitCode != 0) throw FileSystemException('ditto が失敗しました', to.path);
    }
  }

  Future<String?> _bundleId(Directory app) async {
    final r = await _run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', '${app.path}/Contents/Info.plist']);
    return r.exitCode == 0 ? (r.stdout as String).trim() : null;
  }

  Future<void> _quit(String bundle, String? id) async {
    if (id != null) await _run('/usr/bin/osascript', ['-e', 'tell application id "$id" to quit']);
    for (var i = 0; i < 10 && await _isRunning(bundle); i++) {
      await _sleep(const Duration(seconds: 1));
    }
    if (await _isRunning(bundle)) await _run('/usr/bin/pkill', ['-f', '$applicationsDir/$bundle/Contents/MacOS/']);
  }

  /// Upbeater 自身の更新：別プロセスが終了を待って入れ替え、起動を確かめる。起動しなければ前の版に戻して起動する
  Future<InstallResult> _selfUpdate(Directory staged, String bundle) async {
    final keep = Directory('${workDir.path}/self-${DateTime.now().millisecondsSinceEpoch}.app');
    await staged.rename(keep.path);
    final script = File('${workDir.path}/self-update.sh');
    await script.writeAsString(selfUpdateScript);
    await Process.start('/bin/sh', [script.path, '$pid', keep.path, '$applicationsDir/$bundle', '${workDir.path}/self-update-failed'],
        mode: ProcessStartMode.detached);
    Timer(const Duration(seconds: 2), () => onSelfUpdate?.call());
    return const InstallResult.ok('自己更新を別プロセスで行います');
  }
}

/// 自己更新の手順（引数：元のプロセス ID、新しい .app、導入先、失敗の目印のファイル）
const selfUpdateScript = r'''#!/bin/sh
set -u
PID="$1"; NEW="$2"; TARGET="$3"; MARK="$4"
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
OLD="$TARGET.upbeater-old"
rm -rf "$OLD"
[ -d "$TARGET" ] && mv "$TARGET" "$OLD"
if ! mv "$NEW" "$TARGET"; then
  [ -d "$OLD" ] && mv "$OLD" "$TARGET"; echo "move" > "$MARK"; open "$TARGET"; exit 1
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
open "$TARGET"; sleep 15
if ! pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  rm -rf "$TARGET"; [ -d "$OLD" ] && mv "$OLD" "$TARGET"; echo "launch" > "$MARK"; open "$TARGET"; exit 1
fi
rm -rf "$OLD"
''';

class MacosDiskSpace implements DiskSpace {
  MacosDiskSpace({ProcessRunner? run}) : _run = run ?? _defaultRunner;
  final ProcessRunner _run;

  @override
  Future<int?> freeBytes(Directory dir) async {
    await dir.create(recursive: true);
    final r = await _run('/bin/df', ['-k', dir.path]);
    if (r.exitCode != 0) return null;
    final lines = (r.stdout as String).trim().split('\n');
    if (lines.length < 2) return null;
    final cols = lines.last.trim().split(RegExp(r'\s+'));
    final kb = cols.length > 3 ? int.tryParse(cols[3]) : null;
    return kb == null ? null : kb * 1024;
  }
}
