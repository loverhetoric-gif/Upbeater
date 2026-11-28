/// 管理画面（コンソール）全体をつなぐ：接続設定の読み書き、Hub の MCP への呼び出し。
/// 受け手の AppService とは独立で、iOS ではこちらだけが動く。
/// 接続はコード方式：利用者が入れた一回限りのコードを引き換えて得た控えを、
/// 端末の控えとは別キーで、同じ SecretStore（OS の安全な保管場所）に置く
library;

import 'package:flutter/foundation.dart';

import 'core/console_models.dart';
import 'core/mcp_client.dart';
import 'core/state.dart';

const _hubUrlKey = 'upbeater.console_hub_url';
const _tokenKey = 'upbeater.console_mcp_token';

class ConsoleService extends ChangeNotifier {
  ConsoleService({required this.secrets, this.defaultHubUrl = defaultConsoleHubUrl, this.clientFactory, this.redeemFn});

  final McpClient Function(String hubUrl, String token)? clientFactory;

  /// 接続コードの引き換え（テストで差し替える。既定は Hub へ実際に送る）
  final Future<String> Function(String hubUrl, String code)? redeemFn;

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
    if (!configured) throw McpException('管理の設定で接続してください');
    return _client ??= (clientFactory?.call(hubUrl, token) ?? McpClient(hubUrl: hubUrl, token: token));
  }

  /// 接続コードで接続する：引き換えて得た控えを保存する。
  /// 引き換えに失敗したら何も保存しない（呼び出し側で文言を出す）
  Future<void> connectWithCode({required String hubUrl, required String code}) async {
    final url = normalizeHubUrl(hubUrl);
    final redeem = redeemFn ?? (u, c) => redeemConsoleCode(hubUrl: u, code: c);
    final newToken = await redeem(url, code.trim());
    await saveSettings(hubUrl: url, token: newToken);
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

  /// 操作の記録（履歴タブ・通知の差分検出で使う）
  Future<List<OperationItem>> fetchOperations({int limit = 100, bool needsHumanOnly = false, String? repo}) async {
    final r = await client.callTool('list_operations', {
      'limit': limit,
      if (needsHumanOnly) 'needs_human_only': true,
      'repo': ?repo,
    });
    return ((r['operations'] as List?) ?? const []).whereType<Map<String, dynamic>>().map(OperationItem.fromJson).toList();
  }

  Future<List<OperationItem>> fetchNeedsHuman({int limit = 50}) => fetchOperations(limit: limit, needsHumanOnly: true);
}
