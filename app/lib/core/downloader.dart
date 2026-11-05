/// 成果物の取得。中断しても続きから再開し、完了して SHA-256 が一致したものだけを返す。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

class IntegrityException implements Exception {
  IntegrityException(this.message);
  final String message;
  @override
  String toString() => 'IntegrityException($message)';
}

/// URL の期限切れ・取り消し（Hub に照合し直して新しい URL を受け取る）
class UrlRejectedException implements Exception {
  UrlRejectedException(this.status);
  final int status;
}

class DownloadException implements Exception {
  DownloadException(this.message);
  final String message;
  @override
  String toString() => 'DownloadException($message)';
}

class Downloader {
  Downloader({http.Client? client, this.maxAttempts = 5, this.retryDelay = const Duration(seconds: 2)})
      : _client = client ?? http.Client();

  final http.Client _client;
  final int maxAttempts;
  final Duration retryDelay;

  static Future<String> sha256OfFile(File f) async => (await sha256.bind(f.openRead()).first).toString();

  /// [dest] に取得する。途中のものは `dest.part`（と ETag を記録した `dest.part.json`）に置き、再開に使う
  Future<File> download(Uri url, File dest, {required String expectedSha256, required int expectedSize, void Function(int received)? onProgress}) async {
    if (await dest.exists() && await dest.length() == expectedSize && await sha256OfFile(dest) == expectedSha256) return dest;
    await dest.parent.create(recursive: true);
    final part = File('${dest.path}.part');
    final meta = File('${dest.path}.part.json');

    Object? lastError;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await _fetchOnce(url, part, meta, expectedSize, onProgress);
        lastError = null;
        break;
      } on UrlRejectedException {
        rethrow;
      } catch (e) {
        lastError = e;
        if (attempt < maxAttempts) await Future<void>.delayed(retryDelay * attempt);
      }
    }
    if (lastError != null) throw DownloadException('取得できませんでした：$lastError');

    final size = await part.length();
    final actual = await sha256OfFile(part);
    if (size != expectedSize || actual != expectedSha256) {
      // 破棄して、次は最初から取り直す
      await _delete(part);
      await _delete(meta);
      throw IntegrityException('SHA-256 またはサイズが一致しません（受信 $size バイト）');
    }
    await _delete(meta);
    if (await dest.exists()) await dest.delete();
    return part.rename(dest.path);
  }

  Future<void> _fetchOnce(Uri url, File part, File meta, int expectedSize, void Function(int)? onProgress) async {
    var have = await part.exists() ? await part.length() : 0;
    String? etag;
    if (have > 0 && await meta.exists()) {
      try {
        etag = (jsonDecode(await meta.readAsString()) as Map)['etag'] as String?;
      } catch (_) {}
    }
    if (have >= expectedSize && have > 0) return; // 取り終えている（照合は呼び出し側で行う）

    final req = http.Request('GET', url);
    if (have > 0 && etag != null) {
      req.headers['range'] = 'bytes=$have-';
      req.headers['if-range'] = etag; // 中身が変わっていたら全体が返り、継ぎはぎしない
    }
    final res = await _client.send(req).timeout(const Duration(seconds: 60));
    if (res.statusCode == 403 || res.statusCode == 410 || res.statusCode == 404) {
      await res.stream.drain<void>();
      throw UrlRejectedException(res.statusCode);
    }
    IOSink sink;
    if (res.statusCode == 206) {
      sink = part.openWrite(mode: FileMode.append);
    } else if (res.statusCode == 200) {
      have = 0;
      sink = part.openWrite(mode: FileMode.write);
    } else if (res.statusCode == 416) {
      await res.stream.drain<void>();
      await _delete(part);
      throw DownloadException('範囲の指定が受け付けられませんでした');
    } else {
      await res.stream.drain<void>();
      throw DownloadException('Hub が ${res.statusCode} を返しました');
    }
    final newEtag = res.headers['etag'];
    if (newEtag != null) await meta.writeAsString(jsonEncode({'etag': newEtag}));
    try {
      await for (final chunk in res.stream.timeout(const Duration(seconds: 60))) {
        sink.add(chunk);
        have += chunk.length;
        onProgress?.call(have);
      }
    } finally {
      await sink.flush();
      await sink.close();
    }
    if (have < expectedSize) throw DownloadException('途中で切れました（$have / $expectedSize バイト）');
  }

  Future<void> _delete(File f) async {
    if (await f.exists()) await f.delete();
  }
}
