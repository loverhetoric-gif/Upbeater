/// Hub の管理用 MCP（POST /mcp、JSON-RPC 2.0）との通信。
///
/// 接続方式は hub/src/mcp.ts・hub/src/oauth.ts で確認したもの：
/// - initialize の後に tools/call を送る（状態を持たないサーバー）
/// - 認証は Authorization: Bearer。使えるのは2種類
///   - 直接登録トークン `upb_m_...`（期限なし・失効可。管理 API POST /v1/admin/mcp-tokens で発行）
///   - OAuth のアクセストークン `upb_at_...`（1時間。更新トークン30日）
/// - アプリ内 OAuth は、Hub のリダイレクト先検証が https のみ（カスタムスキーム不可）の
///   ため今はできない。管理画面は `upb_m_` を設定で入れる方式にする
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

/// 通信・認証の失敗。message は利用者にそのまま見せてよい日本語
class McpException implements Exception {
  McpException(this.message, {this.isAuthError = false});
  final String message;
  final bool isAuthError;
  @override
  String toString() => message;
}

/// 道具が返した失敗（{ok: false, code, reason}）
class ToolException implements Exception {
  ToolException(this.code, this.reason, {this.needsHuman = false});
  final String code;
  final String reason;
  final bool needsHuman;
  @override
  String toString() => reason;
}

class McpClient {
  McpClient({required this.hubUrl, required this.token, http.Client? httpClient}) : _client = httpClient ?? http.Client();

  /// 末尾のスラッシュなし（例 https://upbeater.loverhetoric.com）
  final String hubUrl;
  final String token;
  final http.Client _client;

  static const protocolVersion = '2025-03-26';
  int _nextId = 1;
  bool _initialized = false;

  Map<String, String> get _headers => {
        'authorization': 'Bearer $token',
        'content-type': 'application/json',
        'accept': 'application/json',
        'mcp-protocol-version': protocolVersion,
      };

  Future<Map<String, dynamic>> _rpc(String method, Map<String, dynamic> params) async {
    final http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$hubUrl/mcp'),
            headers: _headers,
            body: jsonEncode({'jsonrpc': '2.0', 'id': _nextId++, 'method': method, 'params': params}),
          )
          .timeout(const Duration(seconds: 30));
    } catch (e) {
      throw McpException('Hub に接続できませんでした（$e）');
    }
    if (res.statusCode == 401) {
      throw McpException('トークンが無効です。管理の設定で接続用トークン（upb_m_）を確かめてください', isAuthError: true);
    }
    if (res.statusCode != 200) throw McpException('Hub がエラーを返しました（HTTP ${res.statusCode}）');
    final Object? decoded;
    try {
      decoded = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      throw McpException('Hub の応答を読み取れませんでした');
    }
    if (decoded is! Map<String, dynamic>) throw McpException('Hub の応答形式が想定と違います');
    final error = decoded['error'];
    if (error is Map) throw McpException('Hub のエラー：${error['message'] ?? error['code'] ?? '不明'}');
    final result = decoded['result'];
    if (result is! Map<String, dynamic>) throw McpException('Hub の応答に result がありません');
    return result;
  }

  Future<void> _ensureInitialized() async {
    if (_initialized) return;
    await _rpc('initialize', {
      'protocolVersion': protocolVersion,
      'capabilities': {},
      'clientInfo': {'name': 'upbeater-app-console', 'version': '1.0.0'},
    });
    _initialized = true;
  }

  /// 道具を呼び、結果（structuredContent）を返す
  Future<Map<String, dynamic>> callTool(String name, [Map<String, dynamic> args = const {}]) async {
    await _ensureInitialized();
    final result = await _rpc('tools/call', {'name': name, 'arguments': args});
    final payload = decodeToolResult(result);
    if (payload['ok'] == false) {
      throw ToolException(
        payload['code'] as String? ?? 'error',
        payload['reason'] as String? ?? '失敗しました',
        needsHuman: payload['needs_human'] == true,
      );
    }
    return payload;
  }

  /// tools/call の result から道具の返り値を取り出す。
  /// structuredContent があればそれ、無ければ content[0].text の JSON
  static Map<String, dynamic> decodeToolResult(Map<String, dynamic> result) {
    final structured = result['structuredContent'];
    if (structured is Map<String, dynamic>) return structured;
    final content = result['content'];
    if (content is List && content.isNotEmpty) {
      final first = content.first;
      if (first is Map && first['text'] is String) {
        final parsed = jsonDecode(first['text'] as String);
        if (parsed is Map<String, dynamic>) return parsed;
      }
    }
    throw McpException('道具の応答を読み取れませんでした');
  }

  void close() => _client.close();
}
