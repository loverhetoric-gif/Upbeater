import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:upbeater/core/downloader.dart';
import 'package:upbeater/core/hub_client.dart';
import 'package:upbeater/core/manifest.dart';
import 'package:upbeater/core/state.dart';
import 'package:upbeater/core/updater.dart';

import 'support/fake_hub.dart';
import 'support/fakes.dart';

void main() {
  late FakeHub hub;
  late Directory dir;
  late FakeInstaller inst;
  late FakeDisk disk;
  late FakeNetwork net;
  late DeviceState state;
  late Updater up;

  Updater make({FakeInstaller? installer, TrustedKeys? keys}) => Updater(
        hub: HubClient(hub.url, token: 'upb_d_test'),
        store: StateStore(File('${dir.path}/state.json')),
        state: state,
        keys: keys ?? hub.keys,
        installer: installer ?? inst,
        disk: disk,
        network: net,
        versionsDir: Directory('${dir.path}/versions'),
        downloader: Downloader(retryDelay: const Duration(milliseconds: 5)),
      );

  setUp(() async {
    hub = await FakeHub.start();
    dir = await Directory.systemTemp.createTemp('upb-up-');
    inst = FakeInstaller();
    disk = FakeDisk();
    net = FakeNetwork();
    state = DeviceState(hubUrl: hub.url.toString(), deviceId: 'dev1');
    up = make();
  });
  tearDown(() async {
    await hub.close();
    await dir.delete(recursive: true);
  });

  List<String> statuses() => hub.reports.map((r) => '${r['seq']}:${r['status']}').toList();

  test('長期間オフラインでも、途中の版を飛ばして最新版へ直接更新し、結果を報告する', () async {
    for (var i = 1; i <= 5; i++) {
      hub.publish('app1', i, List.filled(100 + i, i));
    }
    expect(await up.checkAll(), {'app1': Outcome.installed});
    expect(inst.installed, [5]);
    expect(state.app('app1').currentSeq, 5);
    expect(statuses(), ['5:downloading', '5:installing', '5:installed']);
    // 状態はファイルに保存され、読み直しても同じ
    final again = await StateStore(File('${dir.path}/state.json')).load();
    expect(again.app('app1').currentSeq, 5);
    expect(await up.checkAll(), {'app1': Outcome.upToDate});
  });

  test('導入に失敗したら、直前の版へ自動で戻す', () async {
    hub.publish('app1', 1, [1, 1, 1]);
    await up.checkAll();
    hub.publish('app1', 2, [2, 2, 2]);
    inst.failNext = true;
    expect(await up.checkApp('app1'), Outcome.rolledBack);
    expect(state.app('app1').currentSeq, 1);
    expect(inst.restored.single, contains('/app1/1-'));
    expect(statuses().last, '1:rolled_back');
  });

  test('入れ替え後に起動しなければ戻し、その版は二度と試さない', () async {
    hub.publish('app1', 1, [1]);
    await up.checkAll();
    hub.publish('app1', 2, [2]);
    inst.unhealthy = true;
    expect(await up.checkApp('app1'), Outcome.rolledBack);
    expect(state.app('app1').currentSeq, 1);
    inst.unhealthy = false;
    final downloads = hub.downloads;
    expect(await up.checkApp('app1'), Outcome.skipped);
    expect(hub.downloads, downloads);
  });

  test('端末には直近 2 つの版を保持し、それより古いものは消す', () async {
    for (var i = 1; i <= 3; i++) {
      hub.publish('app1', i, List.filled(10, i));
      await up.checkApp('app1');
    }
    final kept = state.app('app1').kept;
    expect(kept.map((k) => k.seq), [3, 2]);
    final files = Directory('${dir.path}/versions/app1').listSync().map((f) => f.uri.pathSegments.last).toList();
    expect(files.length, 2);
    expect(files.any((f) => f.startsWith('1-')), isFalse);
  });

  test('SHA-256 の不一致は破棄して再取得し、繰り返す場合はその版を試さない', () async {
    hub.publish('app1', 1, [9, 9, 9]);
    hub.corrupt = true;
    expect(await up.checkApp('app1'), Outcome.failed);
    expect(await up.checkApp('app1'), Outcome.failed);
    expect(await up.checkApp('app1'), Outcome.skipped);
    expect(inst.installed, isEmpty);
    expect(hub.reports.where((r) => r['stage'] == 'verifying'), hasLength(2));
    expect(state.app('app1').currentSeq, 0); // 動いていた版のまま
  });

  test('古い版へのすり替えは拒否し、署名付きの巻き戻し指示なら戻す', () async {
    hub.publish('app1', 1, [1]);
    hub.publish('app1', 2, [2]);
    await up.checkApp('app1');
    expect(state.app('app1').currentSeq, 2);
    hub.pinned = 1; // Hub が巻き戻しを指示
    expect(await up.checkApp('app1'), Outcome.installed);
    expect(state.app('app1').currentSeq, 1);
    expect(hub.reports.last['stage'], 'rollback');
  });

  test('検証用の公開鍵が違えば、何も導入しない', () async {
    hub.publish('app1', 1, [1]);
    final other = make(keys: TrustedKeys({1: 'A' * 43}));
    expect(await other.checkApp('app1'), Outcome.rejected);
    expect(inst.installed, isEmpty);
    expect(hub.downloads, 0);
    final none = make(keys: TrustedKeys({}));
    expect(await none.checkApp('app1'), Outcome.rejected);
  });

  test('空き容量が足りなければ取得せずに保留し、理由を報告する', () async {
    hub.publish('app1', 1, List.filled(1000, 1));
    disk.free = 10 * 1024 * 1024;
    expect(await up.checkApp('app1'), Outcome.deferred);
    expect(hub.downloads, 0);
    expect(hub.reports.last['stage'], 'disk_space');
    expect(hub.reports.last['message'], contains('空き容量'));
    disk.free = null;
    expect(await up.checkApp('app1'), Outcome.installed);
  });

  test('「Wi-Fi 接続時のみ」の設定では、従量制の回線では待つ', () async {
    hub.publish('app1', 1, [1]);
    state.wifiOnly = true;
    net.unmetered = false;
    expect(await up.checkApp('app1'), Outcome.deferred);
    expect(hub.downloads, 0);
    net.unmetered = true;
    expect(await up.checkApp('app1'), Outcome.installed);
  });

  test('対象アプリが使用中・導入の許可がない場合は保留する', () async {
    hub.publish('app1', 1, [1]);
    inst.runningMessage = '使用中のため、終了を待って入れ替えます';
    expect(await up.checkApp('app1'), Outcome.deferred);
    inst.runningMessage = null;
    inst.permissionMessage = '「不明なアプリのインストール」を Upbeater に許可してください';
    expect(await up.checkApp('app1'), Outcome.deferred);
    expect(hub.reports.last['stage'], 'permission');
  });

  test('Hub が止まっていても落ちず、現行版のまま。復旧後に追いつく', () async {
    hub.publish('app1', 1, [1]);
    await up.checkAll();
    hub.publish('app1', 2, [2]);
    hub.down = true;
    expect(await up.checkAll(), {'app1': Outcome.hubUnreachable});
    expect(state.app('app1').currentSeq, 1);
    hub.down = false;
    expect(await up.checkAll(), {'app1': Outcome.installed});
    expect(state.app('app1').currentSeq, 2);
  });

  test('成果物の URL が期限切れなら、照合し直して取得を続ける', () async {
    hub.publish('app1', 1, [1, 2, 3]);
    hub.expireUrls = 1;
    expect(await up.checkApp('app1'), Outcome.installed);
  });

  test('前の版に戻せない OS（Android）では、導入の失敗で現行版をそのまま残す', () async {
    final android = FakeInstaller(restorable: false);
    final u = make(installer: android);
    hub.publish('app1', 1, [1]);
    await u.checkApp('app1');
    hub.publish('app1', 2, [2]);
    android.failNext = true;
    expect(await u.checkApp('app1'), Outcome.failed);
    expect(state.app('app1').currentSeq, 1);
    expect(android.restored, isEmpty);
  });
}
