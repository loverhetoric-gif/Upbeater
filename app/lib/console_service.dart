/// 管理画面（コンソール）全体をつなぐ：接続設定の読み書き、Hub の MCP への呼び出し。
/// 受け手の AppService とは独立で、iOS ではこちらだけが動く。
/// トークンは端末トークンとは別キーで、同じ SecretStore（OS の安全な保管場所）に置く
library;

import 'package:flutter/foundation.dart';

import 'core/console_models.dart';
import 'core/mcp_client.dart';
import 'core/state.dart';

const _hubUrlKey = 'upbeater.console_hub_url';
const _tokenKey = 'upbeater.console_mcp_token';

class ConsoleService extends ChangeNotifier {
  ConsoleService({required this.secrets, this.defaultHubUrl = defaultConsoleHubUrl, this.clientFactory});

  final McpClient Function(String hubUrl, String token)? clientFactory;

  static const defaultConsoleHubUrl = 'https://upbeater.loverhetoric.com';

  final SecretStore secrets;

  /// 受け手として登録済みの Hub があれば、その URL を初期値にするための受け口
  final String defaultHubUrl;

  String hubUrl = defaultConsoleHubUrl;
  String token = '';
  McpClient? _client;

  bool get configured => token.isNotEmpty;

  Future<void> init() async {
    hubUrl = (await secrets.read(_hubUrlKey)) ?? defaultHubUrl;
    token = (await secrets.read(_tokenKey)) ?? '';
    notifyListeners();
  }

  McpClient get client {
    if (!configured) throw McpException('管理の設定で接続用トークン（upb_m_）を入れてください');
    return _client ??= (clientFactory?.call(hubUrl, token) ?? McpClient(hubUrl: hubUrl, token: token));
  }

  Future<void> saveSettings({required String hubUrl, required String token}) async {
    this.hubUrl = normalizeHubUrl(hubUrl);
    this.token = token.trim();
    await secrets.write(_hubUrlKey, this.hubUrl);
    await secrets.write(_tokenKey, this.token);
    _client?.close();
    _client = null;
    notifyListeners();
  }

  Future<void> clearToken() async {
    token = '';
    await secrets.delete(_tokenKey);
    _client?.close();
    _client = null;
    notifyListeners();
  }

  static String normalizeHubUrl(String url) {
    final u = url.trim().replaceAll(RegExp(r'/+$'), '');
    return u.isEmpty ? defaultConsoleHubUrl : u;
  }

  // ── 道具の呼び出し ──

  /// 接続確認も兼ねる（返れば認証も通っている）
  Future<List<RepoItem>> fetchRepos() async {
    final r = await client.callTool('list_repos');
    return ((r['repos'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(RepoItem.fromJson).toList();
  }

  Future<List<RunItem>> fetchRuns({int limit = 50}) async {
    final r = await client.callTool('list_runs', {'limit': limit});
    return ((r['runs'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(RunItem.fromJson).toList();
  }

  Future<RunDetail> fetchRun(String runId) async => RunDetail.fromJson(await client.callTool('get_run', {'run_id': runId}));

  Future<String> fetchLogs(String jobId, {int lines = 500}) async {
    final r = await client.callTool('get_logs', {'job_id': jobId, 'lines': lines});
    final text = r['log'] as String? ?? '';
    return r['truncated'] == true ? '…（末尾のみ表示）\n$text' : text;
  }

  Future<void> rerun(String runId) async {
    await client.callTool('rerun', {'run_id': runId});
  }

  Future<void> cancel(String runId) async {
    await client.callTool('cancel', {'run_id': runId});
  }

  Future<List<DeviceItem>> fetchDevices() async {
    final r = await client.callTool('list_devices');
    return ((r['devices'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(DeviceItem.fromJson).toList();
  }

  Future<InstallStatus> fetchInstallStatus(String repo) async =>
      InstallStatus.fromJson(await client.callTool('get_install_status', {'repo': repo}));

  Future<List<OperationItem>> fetchNeedsHuman({int limit = 50}) async {
    final r = await client.callTool('list_operations', {'needs_human_only': true, 'limit': limit});
    return ((r['operations'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(OperationItem.fromJson).toList();
  }
}
