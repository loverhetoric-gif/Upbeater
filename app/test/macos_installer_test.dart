import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:upbeater/core/manifest.dart';
import 'package:upbeater/platform/macos.dart';

/// macOS の入れ替えを、本物の tar と模擬の macOS コマンドで確かめる
void main() {
  late Directory root;
  late Directory apps;
  late Directory work;
  late Map<String, bool> running;
  late List<String> calls;
  var healthyAfterOpen = true;

  Future<File> archive(String bundle, String id, String version) async {
    final src = Directory('${root.path}/src-$version/$bundle/Contents/MacOS')..createSync(recursive: true);
    File('${src.path}/app').writeAsStringSync(version);
    File('${src.parent.path}/Info.plist').writeAsStringSync(id);
    final out = File('${root.path}/art-$version.tar.gz');
    final r = await Process.run('tar', ['-czf', out.path, '-C', '${root.path}/src-$version', bundle]);
    expect(r.exitCode, 0);
    return out;
  }

  Future<ProcessResult> run(String exe, List<String> args) async {
    calls.add('${exe.split('/').last} ${args.join(' ')}');
    ProcessResult res(int code, [String out = '']) => ProcessResult(0, code, out, '');
    switch (exe) {
      case '/usr/bin/tar':
        return Process.run('tar', args);
      case '/usr/bin/ditto':
        return Process.run('cp', ['-R', args[0], args[1]]);
      case '/usr/libexec/PlistBuddy':
        final f = File(args[2]);
        return f.existsSync() ? res(0, f.readAsStringSync()) : res(1);
      case '/usr/bin/pgrep':
        final bundle = args[1].split('/').reversed.skip(3).first;
        return res(running[bundle] == true ? 0 : 1);
      case '/usr/bin/open':
        running[args[0].split('/').last] = healthyAfterOpen;
        return res(0);
      case '/usr/bin/osascript':
      case '/usr/bin/pkill':
        running.updateAll((_, _) => false);
        return res(0);
      default:
        return res(0);
    }
  }

  MacosInstaller installer() => MacosInstaller(workDir: work, applicationsDir: apps.path, run: run, sleep: (_) async {});

  ManifestBody body(Map<String, dynamic> install) => ManifestBody(
        appId: 'a',
        os: 'macos',
        seq: 2,
        commitSha: 'c',
        releaseId: 'r',
        sha256: 's',
        size: 1,
        url: 'u',
        issuedAt: 0,
        expiresAt: 0,
        keyGeneration: 1,
        install: install,
      );

  String installedVersion() => File('${apps.path}/Foo.app/Contents/MacOS/app').readAsStringSync();

  setUp(() async {
    root = await Directory.systemTemp.createTemp('upb-mac-');
    apps = Directory('${root.path}/Applications')..createSync();
    work = Directory('${root.path}/work');
    running = {};
    calls = [];
    healthyAfterOpen = true;
  });
  tearDown(() => root.delete(recursive: true));

  test('既存の .app を差し替え、隔離属性を外す。古い版の残りは残さない', () async {
    final i = installer();
    expect((await i.install(await archive('Foo.app', 'com.example.foo', 'v1'), body({'bundle': 'Foo.app'}))).ok, isTrue);
    expect((await i.install(await archive('Foo.app', 'com.example.foo', 'v2'), body({'bundle': 'Foo.app', 'bundle_id': 'com.example.foo'}))).ok, isTrue);
    expect(installedVersion(), 'v2');
    expect(Directory('${apps.path}/Foo.app.upbeater-old').existsSync(), isFalse);
    expect(calls.any((c) => c.startsWith('xattr -dr com.apple.quarantine')), isTrue);
    expect(work.listSync().where((e) => e.path.contains('staging-')), isEmpty);
  });

  test('バンドル ID が違う成果物は入れず、導入済みの版を残す', () async {
    final i = installer();
    await i.install(await archive('Foo.app', 'com.example.foo', 'v1'), body({'bundle': 'Foo.app'}));
    final r = await i.install(await archive('Foo.app', 'com.evil.app', 'v2'), body({'bundle': 'Foo.app', 'bundle_id': 'com.example.foo'}));
    expect(r.ok, isFalse);
    expect(r.message, contains('バンドル ID'));
    expect(installedVersion(), 'v1');
  });

  test('使用中のアプリは、設定に従って待つか、終了させて入れ替える', () async {
    final i = installer();
    await i.install(await archive('Foo.app', 'com.example.foo', 'v1'), body({'bundle': 'Foo.app'}));
    running['Foo.app'] = true;
    expect(await i.deferIfRunning(body({'bundle': 'Foo.app'})), contains('終了を待って'));
    expect(await i.deferIfRunning(body({'bundle': 'Foo.app', 'when_running': 'next_launch'})), contains('次に終了'));
    expect(await i.deferIfRunning(body({'bundle': 'Foo.app', 'when_running': 'restart'})), isNull);
    final r = await i.install(await archive('Foo.app', 'com.example.foo', 'v2'), body({'bundle': 'Foo.app', 'when_running': 'restart'}));
    expect(r.ok, isTrue);
    expect(calls.any((c) => c.startsWith('osascript')), isTrue);
    expect(installedVersion(), 'v2');
  });

  test('起動を確かめ、起動しなければ false を返す。保持していた版で元に戻せる', () async {
    final i = installer();
    final v1 = await archive('Foo.app', 'com.example.foo', 'v1');
    await i.install(v1, body({'bundle': 'Foo.app'}));
    await i.install(await archive('Foo.app', 'com.example.foo', 'v2'), body({'bundle': 'Foo.app'}));
    healthyAfterOpen = false;
    expect(await i.healthCheck(body({'bundle': 'Foo.app', 'health_seconds': 5})), isFalse);
    expect((await i.restore(v1, {'bundle': 'Foo.app'})).ok, isTrue);
    expect(installedVersion(), 'v1');
    healthyAfterOpen = true;
    expect(await i.healthCheck(body({'bundle': 'Foo.app'})), isTrue);
    expect(await i.healthCheck(body({'bundle': 'Foo.app', 'health_seconds': 0})), isTrue);
  });

  test('壊れた成果物・.app を含まない成果物は入れない', () async {
    final i = installer();
    final broken = File('${root.path}/broken.tar.gz')..writeAsStringSync('not a tar');
    expect((await i.install(broken, body({}))).ok, isFalse);
    expect(apps.listSync(), isEmpty);
  });

  test('空き容量は df の結果から読む', () async {
    final d = MacosDiskSpace(run: (exe, args) async => ProcessResult(0, 0, 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk1 1000 200 800 20% /\n', ''));
    expect(await d.freeBytes(work), 800 * 1024);
  });
}
