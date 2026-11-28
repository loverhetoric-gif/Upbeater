import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:upbeater/console_service.dart';
import 'package:upbeater/core/console_models.dart';
import 'package:upbeater/core/mcp_client.dart';
import 'package:upbeater/core/state.dart';
import 'package:upbeater/ui/console_home.dart';
import 'package:upbeater/ui/console_settings_screen.dart';
import 'package:upbeater/ui/theme.dart';

http.Response jsonResponse(Object? payload) =>
    http.Response.bytes(utf8.encode(jsonEncode(payload)), 200, headers: {'content-type': 'application/json; charset=utf-8'});

/// 道具の名前ごとに決まった返り値を返す模擬 Hub
MockClient fakeHub(Map<String, Object?> tools) {
  return MockClient((req) async {
    expect(req.headers['authorization'], 'Bearer upb_m_test');
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    if (body['method'] == 'initialize') {
      return jsonResponse({'jsonrpc': '2.0', 'id': body['id'], 'result': {'protocolVersion': '2025-03-26'}});
    }
    final params = body['params'] as Map<String, dynamic>;
    final payload = tools[params['name']];
    if (payload == null) return jsonResponse({'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32601, 'message': 'no tool'}});
    return jsonResponse({
      'jsonrpc': '2.0',
      'id': body['id'],
      'result': {'content': [{'type': 'text', 'text': jsonEncode(payload)}], 'structuredContent': payload, 'isError': false},
    });
  });
}

ConsoleService serviceWith(Map<String, Object?> tools) {
  final s = ConsoleService(
    secrets: MemorySecretStore(),
    clientFactory: (url, token) => McpClient(hubUrl: url, token: token, httpClient: fakeHub(tools)),
  );
  s.token = 'upb_m_test';
  return s;
}

void main() {
  test('MCP：initialize の後に tools/call を送り、structuredContent を返す', () async {
    final s = serviceWith({
      'list_runs': {
        'ok': true,
        'runs': [
          {'run_id': '11111111-1111-1111-1111-111111111111', 'repo': 'o/r', 'number': 3, 'workflow': '.upbeater/test.yml', 'event': 'push', 'branch': 'main', 'status': 'completed', 'conclusion': 'failure', 'created_at': 1764000000000, 'updated_at': 1764000060000},
        ],
      },
    });
    final runs = await s.fetchRuns();
    expect(runs.single.repo, 'o/r');
    expect(runs.single.isFailure, isTrue);
    expect(runs.single.number, 3);
  });

  test('MCP：道具の失敗（ok: false）は ToolException になる', () async {
    final s = serviceWith({
      'rerun': {'ok': false, 'code': 'nothing_to_rerun', 'reason': '再実行するジョブがありません', 'retryable': false, 'needs_human': false},
    });
    await expectLater(s.rerun('11111111-1111-1111-1111-111111111111'), throwsA(isA<ToolException>().having((e) => e.code, 'code', 'nothing_to_rerun')));
  });

  test('MCP：401 は認証エラーになる', () async {
    final client = McpClient(
      hubUrl: 'https://example.invalid',
      token: 'upb_m_bad',
      httpClient: MockClient((_) async => http.Response('{}', 401)),
    );
    await expectLater(client.callTool('list_repos'), throwsA(isA<McpException>().having((e) => e.isAuthError, 'isAuthError', isTrue)));
  });

  test('モデル：get_install_status の形を読む', () {
    final st = InstallStatus.fromJson({
      'repo': 'o/r',
      'releases': [
        {'platform': 'android', 'seq': 5, 'status': 'ready', 'filename': 'a.apk', 'created_at': 1764000000000},
        {'platform': 'android', 'seq': 6, 'status': 'halted', 'filename': 'a.apk', 'created_at': 1764000100000},
      ],
      'settings': [
        {'platform': 'android', 'paused': 0, 'pinned_seq': null, 'staged': 1},
      ],
      'devices': [
        {'device': 'Pixel', 'os': 'android', 'seq': 5, 'status': 'installed', 'message': null, 'updated_at': 1764000200000, 'targeted': true},
      ],
    });
    expect(st.latestReady('android')?.seq, 5);
    expect(st.settingOf('android')?.staged, isTrue);
    expect(st.devices.single.targeted, isTrue);
  });

  testWidgets('管理画面：認証を通るとタブが出て、実行一覧に失敗が出る', (t) async {
    t.view.physicalSize = const Size(360, 740);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final s = serviceWith({
      'list_runs': {
        'ok': true,
        'runs': [
          {'run_id': '11111111-1111-1111-1111-111111111111', 'repo': 'o/r', 'number': 3, 'workflow': 'test.yml', 'event': 'push', 'branch': 'main', 'status': 'completed', 'conclusion': 'failure', 'created_at': 1764000000000, 'updated_at': 1764000060000},
        ],
      },
      'list_repos': {'ok': true, 'repos': []},
      'list_devices': {'ok': true, 'devices': []},
      'list_operations': {'ok': true, 'operations': []},
    });
    await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: ConsoleLockGate(service: s, authenticator: () async => true)));
    await t.pumpAndSettle();
    expect(find.text('実行'), findsOneWidget);
    expect(find.text('配布'), findsOneWidget);
    expect(find.text('要対応'), findsOneWidget);
    expect(find.text('#3 test.yml'), findsOneWidget);
    expect(find.text('失敗'), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  test('引き換え：201 で接続の控えを返し、400 はコードの文言になる', () async {
    final ok = MockClient((req) async {
      expect(req.url.path, '/v1/console/redeem');
      expect((jsonDecode(req.body) as Map)['code'], 'ABCDE-FGHIJ');
      return http.Response(jsonEncode({'token': 'upb_m_test', 'name': 'console-app'}), 201, headers: {'content-type': 'application/json'});
    });
    expect(await redeemConsoleCode(hubUrl: 'https://hub.example', code: 'ABCDE-FGHIJ', httpClient: ok), 'upb_m_test');
    final bad = MockClient((_) async => http.Response(jsonEncode({'error': 'invalid_code'}), 400, headers: {'content-type': 'application/json'}));
    await expectLater(
      redeemConsoleCode(hubUrl: 'https://hub.example', code: 'XXXXX-XXXXX', httpClient: bad),
      throwsA(isA<McpException>().having((e) => e.message, 'message', '接続コードが無効か、期限切れか、使用済みです')),
    );
  });

  test('接続コード：引き換えに成功すると保存され、接続確認が走る', () async {
    final store = MemorySecretStore();
    final s = ConsoleService(
      secrets: store,
      redeemFn: (url, code) async {
        expect(url, 'https://hub.example');
        expect(code, 'ABCDE-FGHIJ');
        return 'upb_m_test';
      },
      clientFactory: (url, token) => McpClient(hubUrl: url, token: token, httpClient: fakeHub({
            'list_repos': {
              'ok': true,
              'repos': [
                {'repo': 'o/r'},
              ],
            },
          })),
    );
    await s.connectWithCode(hubUrl: 'https://hub.example/', code: ' ABCDE-FGHIJ ');
    expect(s.configured, isTrue);
    expect(s.token, 'upb_m_test');
    // 保存されている（作り直して読み戻せる）
    final restored = ConsoleService(secrets: store);
    await restored.init();
    expect(restored.token, 'upb_m_test');
    expect(restored.hubUrl, 'https://hub.example');
    // 接続確認（道具の呼び出し）が通る
    expect((await s.fetchRepos()).single.fullName, 'o/r');
  });

  test('接続コード：引き換えに失敗すると何も保存されない', () async {
    final store = MemorySecretStore();
    final s = ConsoleService(
      secrets: store,
      redeemFn: (url, code) async => throw McpException('接続コードが無効か、期限切れか、使用済みです'),
    );
    await expectLater(s.connectWithCode(hubUrl: 'https://hub.example', code: 'XXXXX-XXXXX'), throwsA(isA<McpException>()));
    expect(s.configured, isFalse);
    final restored = ConsoleService(secrets: store);
    await restored.init();
    expect(restored.token, '');
  });

  testWidgets('設定画面：コードで接続すると接続済みになり、解除できる', (t) async {
    final s = ConsoleService(
      secrets: MemorySecretStore(),
      redeemFn: (url, code) async => 'upb_m_test',
      clientFactory: (url, token) => McpClient(hubUrl: url, token: token, httpClient: fakeHub({
            'list_repos': {'ok': true, 'repos': []},
          })),
    );
    await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: ConsoleSettingsScreen(service: s))));
    await t.pumpAndSettle();
    expect(find.textContaining('トークン'), findsNothing);
    expect(find.text('接続コード'), findsOneWidget);
    await t.enterText(find.byType(TextField).at(1), 'ABCDE-FGHIJ');
    await t.tap(find.text('接続する'));
    await t.pumpAndSettle();
    expect(find.textContaining('接続できました'), findsOneWidget);
    expect(find.textContaining('接続済み'), findsOneWidget);
    expect(s.configured, isTrue);
    await t.tap(find.text('接続を解除'));
    await t.pumpAndSettle();
    expect(find.text('接続を解除しました'), findsOneWidget);
    expect(s.configured, isFalse);
    expect(t.takeException(), isNull);
  });

  testWidgets('設定画面：引き換えに失敗するとエラーが出て、接続済みにならない', (t) async {
    final s = ConsoleService(
      secrets: MemorySecretStore(),
      redeemFn: (url, code) async => throw McpException('接続コードが無効か、期限切れか、使用済みです'),
    );
    await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: ConsoleSettingsScreen(service: s))));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField).at(1), 'XXXXX-XXXXX');
    await t.tap(find.text('接続する'));
    await t.pumpAndSettle();
    expect(find.text('接続コードが無効か、期限切れか、使用済みです'), findsOneWidget);
    expect(find.text('接続を解除'), findsNothing);
    expect(s.configured, isFalse);
    expect(t.takeException(), isNull);
  });

  testWidgets('管理画面：認証が通らなければ中身を出さない', (t) async {
    final s = serviceWith({});
    await t.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: ConsoleLockGate(service: s, authenticator: () async => false)));
    await t.pumpAndSettle();
    expect(find.text('管理画面はロックされています'), findsOneWidget);
    expect(find.text('実行'), findsNothing);
    expect(t.takeException(), isNull);
  });
}
