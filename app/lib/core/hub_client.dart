/// Hub との通信（端末 API）
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'manifest.dart';

class HubException implements Exception {
  HubException(this.code, this.message, {this.retryable = false, this.status});
  final String code;
  final String message;
  final bool retryable;
  final int? status;
  @override
  String toString() => 'HubException($code: $message)';
}

class RemoteApp {
  RemoteApp({required this.appId, required this.name, this.readySeq});
  final String appId;
  final String name;
  final int? readySeq;
}

class CheckResponse {
  CheckResponse({required this.update, required this.latestSeq, this.manifest, this.revokedGenerations = const {}});
  final bool update;
  final int latestSeq;
  final SignedManifest? manifest;
  final Set<int> revokedGenerations;
}

class Registration {
  Registration({required this.deviceId, required this.token});
  final String deviceId;
  final String token;
}

class HubClient {
  HubClient(this.baseUrl, {this.token, http.Client? client}) : _client = client ?? http.Client();

  final Uri baseUrl;
  String? token;
  final http.Client _client;

  Uri _u(String path) => baseUrl.resolve(path);

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body, bool auth = true}) async {
    final req = http.Request(method, _u(path));
    req.headers['content-type'] = 'application/json';
    req.headers['accept'] = 'application/json';
    if (auth && token != null) req.headers['authorization'] = 'Bearer $token';
    if (body != null) req.body = jsonEncode(body);
    http.StreamedResponse res;
    try {
      res = await _client.send(req).timeout(const Duration(seconds: 30));
    } catch (_) {
      throw HubException('unreachable', 'Hub に接続できません', retryable: true);
    }
    final text = await res.stream.bytesToString();
    Map<String, dynamic> json = {};
    try {
      if (text.isNotEmpty) json = jsonDecode(text) as Map<String, dynamic>;
    } catch (_) {}
    if (res.statusCode >= 500 || res.statusCode == 429) {
      throw HubException('unavailable', 'Hub が応答できません（${res.statusCode}）', retryable: true, status: res.statusCode);
    }
    if (res.statusCode >= 400) {
      throw HubException(json['error'] as String? ?? 'error', json['message'] as String? ?? 'Hub がエラーを返しました（${res.statusCode}）',
          status: res.statusCode);
    }
    return json;
  }

  Future<Registration> register({required String code, required String name, required String os}) async {
    final j = await _send('POST', '/v1/devices/register', body: {'code': code, 'name': name, 'os': os}, auth: false);
    return Registration(deviceId: j['device_id'] as String, token: j['token'] as String);
  }

  Future<List<RemoteApp>> apps() async {
    final j = await _send('GET', '/v1/devices/apps');
    return (j['apps'] as List)
        .cast<Map<String, dynamic>>()
        .map((a) => RemoteApp(appId: a['app_id'] as String, name: a['name'] as String, readySeq: (a['ready_seq'] as num?)?.toInt()))
        .toList();
  }

  Future<CheckResponse> check(String appId, int currentSeq) async {
    final j = await _send('POST', '/v1/devices/check', body: {'app_id': appId, 'current_seq': currentSeq});
    final revoked = <int>{};
    for (final k in (j['public_keys'] as List? ?? const [])) {
      if (k is Map && k['status'] == 'revoked') revoked.add((k['gen'] as num).toInt());
    }
    return CheckResponse(
      update: j['update'] == true,
      latestSeq: (j['latest_seq'] as num?)?.toInt() ?? 0,
      manifest: j['manifest'] is Map ? SignedManifest.fromJson(Map<String, dynamic>.from(j['manifest'] as Map)) : null,
      revokedGenerations: revoked,
    );
  }

  static String? _trim(String? m) => m == null || m.length <= 1900 ? m : m.substring(0, 1900);

  Future<void> report(String appId, int seq, String status, {String? message, String? stage}) async {
    await _send('POST', '/v1/devices/report', body: {
      'app_id': appId,
      'seq': seq,
      'status': status,
      'message': ?_trim(message),
      'stage': ?stage,
    });
  }
}
