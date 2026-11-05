import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as c;
import 'package:cryptography/cryptography.dart';
import 'package:upbeater/core/manifest.dart';

String b64(List<int> b) => base64Url.encode(b).replaceAll('=', '');

/// 端末 API を持つ模擬の Hub（署名・Range 対応の配信・故障の注入）
class FakeHub {
  FakeHub._(this.server, this.keyPair, this.publicX);

  static Future<FakeHub> start() async {
    final kp = await Ed25519().newKeyPair();
    final pub = await kp.extractPublicKey();
    final hub = FakeHub._(await HttpServer.bind(InternetAddress.loopbackIPv4, 0), kp, b64(pub.bytes));
    hub.server.listen(hub._handle);
    return hub;
  }

  final HttpServer server;
  final SimpleKeyPair keyPair;
  final String publicX;
  Uri get url => Uri.parse('http://127.0.0.1:${server.port}');
  TrustedKeys get keys => TrustedKeys({1: publicX});

  /// 公開中の版（appId → 通番 → 成果物）
  final releases = <String, Map<int, List<int>>>{};
  final names = <String, String>{};
  final install = <String, Map<String, dynamic>>{};
  int? pinned;
  final reports = <Map<String, dynamic>>[];
  bool down = false;

  /// 配信の途中で接続を切る（最初の N 回）
  int cutAfterBytes = 0;
  int cutTimes = 0;

  /// 中身を壊して配る（SHA-256 の不一致を起こす）
  bool corrupt = false;

  /// 次の N 回、成果物の URL を期限切れにする
  int expireUrls = 0;
  int downloads = 0;
  final rangeRequests = <String>[];

  void publish(String appId, int seq, List<int> bytes, {String name = 'Widget'}) {
    releases.putIfAbsent(appId, () => {})[seq] = bytes;
    names[appId] = name;
  }

  Future<void> close() => server.close(force: true);

  Future<Map<String, dynamic>> _sign(Map<String, dynamic> body) async {
    final payload = utf8.encode(jsonEncode({'v': 1, ...body, 'key_generation': 1}));
    final sig = await Ed25519().sign(payload, keyPair: keyPair);
    return {'payload': b64(payload), 'signature': b64(sig.bytes), 'key_generation': 1};
  }

  Future<void> _json(HttpResponse res, int status, Object body) async {
    res.statusCode = status;
    res.headers.contentType = ContentType.json;
    res.write(jsonEncode(body));
    await res.close();
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    if (down) return _json(res, 503, {'error': 'down'});
    final path = req.uri.path;
    if (path == '/v1/devices/register') {
      final b = jsonDecode(await utf8.decodeStream(req)) as Map;
      if (b['code'] != 'ABCDE23456') return _json(res, 400, {'error': 'invalid_code', 'message': '無効'});
      return _json(res, 201, {'device_id': 'dev1', 'token': 'upb_d_test'});
    }
    if (req.headers.value('authorization') != 'Bearer upb_d_test' && !path.startsWith('/a/')) return _json(res, 401, {'error': 'unauthorized'});
    if (path == '/v1/devices/apps') {
      return _json(res, 200, {
        'apps': [for (final id in releases.keys) {'app_id': id, 'name': names[id]}],
      });
    }
    if (path == '/v1/devices/check') {
      final b = jsonDecode(await utf8.decodeStream(req)) as Map;
      final id = b['app_id'] as String;
      final current = (b['current_seq'] as num).toInt();
      final rel = releases[id] ?? {};
      if (rel.isEmpty) return _json(res, 200, {'update': false, 'latest_seq': 0});
      final latest = rel.keys.reduce((a, b) => a > b ? a : b);
      final target = pinned ?? latest;
      if (target == current || (pinned == null && latest <= current)) return _json(res, 200, {'update': false, 'latest_seq': latest});
      final bytes = rel[target]!;
      final body = {
        'app_id': id,
        'os': 'macos',
        'seq': target,
        'commit_sha': 'c' * 40,
        'release_id': '$id-$target',
        'sha256': c.sha256.convert(bytes).toString(),
        'size': bytes.length,
        'url': '$url/a/$id/$target',
        'issued_at': 1,
        'expires_at': DateTime.now().millisecondsSinceEpoch + 600000,
        'install': install[id] ?? {},
        if (pinned != null && pinned! < current) 'rollback': {'to_seq': pinned},
      };
      return _json(res, 200, {'update': true, 'manifest': await _sign(body), 'public_keys': []});
    }
    if (path == '/v1/devices/report') {
      reports.add(Map<String, dynamic>.from(jsonDecode(await utf8.decodeStream(req)) as Map));
      return _json(res, 200, {'ok': true});
    }
    final a = RegExp(r'^/a/([^/]+)/(\d+)$').firstMatch(path);
    if (a != null) {
      downloads++;
      if (expireUrls > 0) {
        expireUrls--;
        return _json(res, 403, {'error': 'invalid_or_expired_token'});
      }
      var bytes = releases[a.group(1)]![int.parse(a.group(2)!)]!;
      if (corrupt) bytes = [...bytes]..[0] ^= 0xff;
      final etag = '"${c.sha256.convert(bytes)}"';
      var start = 0;
      final range = req.headers.value('range');
      final ifRange = req.headers.value('if-range');
      if (range != null) rangeRequests.add(range);
      if (range != null && (ifRange == null || ifRange == etag)) start = int.parse(RegExp(r'bytes=(\d+)-').firstMatch(range)!.group(1)!);
      final chunk = bytes.sublist(start);
      if (cutTimes > 0 && chunk.length > cutAfterBytes) {
        cutTimes--;
        // 応答の途中で接続を切る（Content-Length より手前で終わる）
        final socket = await res.detachSocket(writeHeaders: false);
        final head = StringBuffer()
          ..write(start > 0 ? 'HTTP/1.1 206 Partial Content\r\n' : 'HTTP/1.1 200 OK\r\n')
          ..write('content-length: ${chunk.length}\r\n')
          ..write('etag: $etag\r\n')
          ..write(start > 0 ? 'content-range: bytes $start-${bytes.length - 1}/${bytes.length}\r\n' : '')
          ..write('connection: close\r\n\r\n');
        socket.add(utf8.encode(head.toString()));
        socket.add(chunk.sublist(0, cutAfterBytes));
        await socket.flush();
        socket.destroy();
        return;
      }
      res.statusCode = start > 0 ? 206 : 200;
      res.headers.set('etag', etag);
      res.headers.set('accept-ranges', 'bytes');
      if (start > 0) res.headers.set('content-range', 'bytes $start-${bytes.length - 1}/${bytes.length}');
      res.contentLength = chunk.length;
      res.add(chunk);
      return res.close();
    }
    return _json(res, 404, {'error': 'not_found'});
  }
}
