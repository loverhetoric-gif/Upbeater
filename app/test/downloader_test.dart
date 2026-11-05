import 'dart:io';

import 'package:crypto/crypto.dart' as c;
import 'package:flutter_test/flutter_test.dart';
import 'package:upbeater/core/downloader.dart';

import 'support/fake_hub.dart';

void main() {
  late FakeHub hub;
  late Directory dir;
  final bytes = List<int>.generate(300000, (i) => (i * 7 + 3) & 255);
  final sha = c.sha256.convert(bytes).toString();

  setUp(() async {
    hub = await FakeHub.start();
    hub.publish('app1', 1, bytes);
    dir = await Directory.systemTemp.createTemp('upb-dl-');
  });
  tearDown(() async {
    await hub.close();
    await dir.delete(recursive: true);
  });

  Downloader dl() => Downloader(retryDelay: const Duration(milliseconds: 10));

  test('途中で切れても続きから再開し、つないだ結果の SHA-256 が一致する', () async {
    hub.cutAfterBytes = 100000;
    hub.cutTimes = 2;
    final f = await dl().download(Uri.parse('${hub.url}/a/app1/1'), File('${dir.path}/x.bin'), expectedSha256: sha, expectedSize: bytes.length);
    expect(c.sha256.convert(await f.readAsBytes()).toString(), sha);
    expect(hub.rangeRequests, ['bytes=100000-', 'bytes=200000-']); // 最初から取り直していない
    expect(File('${f.path}.part').existsSync(), isFalse);
  });

  test('アプリを閉じて次に開いた時も、残っていた途中から再開する', () async {
    hub.cutAfterBytes = 120000;
    hub.cutTimes = 1;
    final single = Downloader(maxAttempts: 1, retryDelay: Duration.zero);
    final dest = File('${dir.path}/y.bin');
    await expectLater(single.download(Uri.parse('${hub.url}/a/app1/1'), dest, expectedSha256: sha, expectedSize: bytes.length), throwsA(isA<DownloadException>()));
    expect(File('${dest.path}.part').lengthSync(), 120000);
    final f = await dl().download(Uri.parse('${hub.url}/a/app1/1'), dest, expectedSha256: sha, expectedSize: bytes.length);
    expect(c.sha256.convert(await f.readAsBytes()).toString(), sha);
    expect(hub.rangeRequests.last, 'bytes=120000-');
  });

  test('SHA-256 が一致しなければ破棄し、適用しない', () async {
    hub.corrupt = true;
    final dest = File('${dir.path}/z.bin');
    await expectLater(dl().download(Uri.parse('${hub.url}/a/app1/1'), dest, expectedSha256: sha, expectedSize: bytes.length), throwsA(isA<IntegrityException>()));
    expect(dest.existsSync(), isFalse);
    expect(File('${dest.path}.part').existsSync(), isFalse); // 次は最初から取り直す
  });

  test('URL の期限切れは呼び出し側に知らせる（照合し直して新しい URL を受け取る）', () async {
    hub.expireUrls = 1;
    await expectLater(dl().download(Uri.parse('${hub.url}/a/app1/1'), File('${dir.path}/w.bin'), expectedSha256: sha, expectedSize: bytes.length),
        throwsA(isA<UrlRejectedException>()));
  });
}
