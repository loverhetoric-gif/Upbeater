import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:upbeater/console_service.dart';
import 'package:upbeater/core/app_badge_logic.dart';
import 'package:upbeater/core/console_models.dart';
import 'package:upbeater/core/mcp_client.dart';
import 'package:upbeater/core/notification_logic.dart';
import 'package:upbeater/core/operation_labels.dart';
import 'package:upbeater/core/state.dart';
import 'package:upbeater/notification_service.dart';
import 'package:upbeater/ui/app_badge.dart';
import 'package:upbeater/ui/console_history_screen.dart';
import 'package:upbeater/ui/console_settings_screen.dart';
import 'package:upbeater/ui/theme.dart';

http.Response jsonResponse(Object? payload) =>
    http.Response.bytes(utf8.encode(jsonEncode(payload)), 200, headers: {'content-type': 'application/json; charset=utf-8'});

ConsoleService serviceWith(Map<String, Object?> tools) {
  final s = ConsoleService(
    secrets: MemorySecretStore(),
    clientFactory: (url, token) => McpClient(
      hubUrl: url,
      token: token,
      httpClient: MockClient((req) async {
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
      }),
    ),
  );
  s.token = 'upb_m_test';
  return s;
}

RunItem run({required int number, required String conclusion, required int updatedMs, String repo = 'loverhetoric-gif/Upbeater', String workflow = 'test.yml'}) {
  return RunItem.fromJson({
    'run_id': '11111111-1111-1111-1111-11111111111$number',
    'repo': repo,
    'number': number,
    'workflow': workflow,
    'event': 'push',
    'branch': 'main',
    'status': 'completed',
    'conclusion': conclusion,
    'created_at': updatedMs - 60000,
    'updated_at': updatedMs,
  });
}

OperationItem op({required int id, required String kind, String stage = '', String status = 'ok', bool needsHuman = false, String? reason, Map<String, dynamic> detail = const {}, String repo = 'loverhetoric-gif/Upbeater'}) {
  return OperationItem.fromJson({
    'id': id,
    'repo': repo,
    'kind': kind,
    'stage': stage,
    'status': status,
    'reason': reason,
    'needs_human': needsHuman,
    'detail': detail,
    'created_at': 1764000000000,
  });
}

class FakeSink implements NotificationSink {
  final List<(NotifyCategory, String, String)> shown = [];
  bool permissionRequested = false;
  @override
  Future<void> init() async {}
  @override
  Future<void> requestPermission() async => permissionRequested = true;
  @override
  Future<void> show({required NotifyCategory category, required int id, required String title, required String body}) async {
    shown.add((category, title, body));
  }
}

void main() {
  group('AppBadge の決定的な見た目', () {
    test('モノグラム：名前の区切りを考慮した2文字まで', () {
      expect(repoMonogram('loverhetoric-gif/Upbeater'), 'Up');
      expect(repoMonogram('PLEATS-web'), 'PL');
      expect(repoMonogram('o/r'), 'R');
      expect(repoMonogram(''), '?');
      expect(repoShortName('loverhetoric-gif/Upbeater'), 'Upbeater');
    });

    test('色相：同じ repo は常に同じ、違う repo は散る', () {
      expect(repoHue('loverhetoric-gif/Upbeater'), repoHue('loverhetoric-gif/Upbeater'));
      final hues = ['loverhetoric-gif/Upbeater', 'loverhetoric-gif/PLEATS-web', 'loverhetoric-gif/NSC', 'loverhetoric-gif/WARPHOLE'].map(repoHue).toList();
      // 4件とも互いに 20 度以上離れている（十分に異なる色になる）
      for (var i = 0; i < hues.length; i++) {
        for (var j = i + 1; j < hues.length; j++) {
          final diff = (hues[i] - hues[j]).abs();
          expect(diff > 20 && diff < 340, isTrue, reason: '${hues[i]} と ${hues[j]} が近すぎる');
        }
      }
    });

    testWidgets('同じ repo のバッジは同じグラデーションで描かれる', (t) async {
      await t.pumpWidget(const MaterialApp(home: Scaffold(body: Row(children: [AppBadge(repo: 'o/r'), AppBadge(repo: 'o/r')]))));
      final containers = t.widgetList<Container>(find.byType(Container)).where((c) => c.decoration is BoxDecoration).toList();
      expect(containers.length, 2);
      final a = (containers[0].decoration as BoxDecoration).gradient as LinearGradient;
      final b = (containers[1].decoration as BoxDecoration).gradient as LinearGradient;
      expect(a.colors, b.colors);
      expect(find.text('R'), findsNWidgets(2));
    });
  });

  group('操作のラベル変換', () {
    test('kind → 日本語ラベル', () {
      expect(operationKindLabel('auto_merge'), '自動マージ');
      expect(operationKindLabel('manual'), '手動実行');
      expect(operationKindLabel('release'), '配布の用意');
      expect(operationKindLabel('install'), '端末へ導入');
      expect(operationKindLabel('console'), '接続');
      expect(operationKindLabel('unknown_kind'), 'unknown_kind');
      expect(runEventLabel('push'), 'プッシュ');
      expect(runEventLabel('schedule'), '定期');
    });

    test('TestFlight 判定：ワークフロー名・detail・理由文から拾う', () {
      expect(isTestFlightRelated(workflow: '.upbeater/testflight.yml'), isTrue);
      expect(isTestFlightRelated(detail: {'workflow': 'testflight.yml', 'event': 'manual'}), isTrue);
      expect(isTestFlightRelated(reason: 'TestFlight へ送りました（ビルド番号 12）'), isTrue);
      expect(isTestFlightRelated(workflow: 'app-android.yml'), isFalse);
      expect(isTestFlightRelated(detail: {'workflow': 'hub.yml', 'platform': 'ios'}), isFalse);
      expect(isTestFlightRelated(), isFalse);
    });

    test('見出し：TestFlight は専用文言、それ以外は kind のラベル', () {
      final tf = op(id: 1, kind: 'run', stage: 'created', detail: {'workflow': 'testflight.yml'});
      expect(operationTitle(tf), 'TestFlight へ送信');
      final merge = op(id: 2, kind: 'auto_merge', stage: 'merged');
      expect(operationTitle(merge), '自動マージ');
    });

    test('detail の補足行：通番・端末・PR 番号を具体的に出す', () {
      final o = op(id: 3, kind: 'install', detail: {'device': 'iPhone 15', 'seq': 7});
      expect(operationDetailLine(o), contains('iPhone 15'));
      expect(operationDetailLine(o), contains('通番 7'));
      final pr = op(id: 4, kind: 'auto_merge', detail: {'pr_number': 41});
      expect(operationDetailLine(pr), contains('PR #41'));
    });
  });

  group('通知の差分検出', () {
    const baseMs = 1764000000000;

    test('初回（透かし未初期化）は完了があっても何も出さない', () {
      final c = detectNotifications(
        runs: [run(number: 1, conclusion: 'success', updatedMs: baseMs)],
        operations: [op(id: 5, kind: 'release', stage: 'ready')],
        watermark: const NotifyWatermark(),
        enabled: NotifyCategory.values.toSet(),
      );
      expect(c, isEmpty);
    });

    test('透かしより新しい完了だけを出す（成功と失敗を区別）', () {
      final wm = advanceWatermark(const NotifyWatermark(), [run(number: 1, conclusion: 'success', updatedMs: baseMs)], const []);
      expect(wm.initialized, isTrue);
      final c = detectNotifications(
        runs: [
          run(number: 1, conclusion: 'success', updatedMs: baseMs), // 既に見た
          run(number: 2, conclusion: 'failure', updatedMs: baseMs + 60000), // 新しい失敗
          run(number: 3, conclusion: 'success', updatedMs: baseMs + 120000), // 新しい成功
        ],
        operations: const [],
        watermark: wm,
        enabled: NotifyCategory.values.toSet(),
      );
      expect(c.length, 2);
      expect(c.every((x) => x.category == NotifyCategory.runCompleted), isTrue);
      expect(c.map((x) => x.title).join(), contains('失敗'));
      expect(c.map((x) => x.title).join(), contains('成功'));
      expect(c.first.title, startsWith('Upbeater：'));
    });

    test('配布（用意完了・導入完了）と要対応を拾う', () {
      const wm = NotifyWatermark(initialized: true, lastRunUpdatedMs: baseMs, lastOperationId: 10);
      final c = detectNotifications(
        runs: const [],
        operations: [
          op(id: 9, kind: 'release', stage: 'ready'), // 既に見た
          op(id: 11, kind: 'release', stage: 'ready', detail: {'platform': 'ios', 'seq': 3}),
          op(id: 12, kind: 'install', stage: 'installed', detail: {'device': 'iPhone 15', 'seq': 3}),
          op(id: 13, kind: 'run', stage: 'completed', status: 'failed', needsHuman: true, reason: '検査が失敗しました'),
        ],
        watermark: wm,
        enabled: NotifyCategory.values.toSet(),
      );
      expect(c.length, 3);
      expect(c.where((x) => x.category == NotifyCategory.distribution).length, 2);
      expect(c.where((x) => x.category == NotifyCategory.attention).length, 1);
      expect(c.last.body, contains('検査が失敗しました'));
    });

    test('オフのカテゴリは出さない', () {
      const wm = NotifyWatermark(initialized: true, lastRunUpdatedMs: baseMs, lastOperationId: 0);
      final c = detectNotifications(
        runs: [run(number: 9, conclusion: 'failure', updatedMs: baseMs + 1000)],
        operations: [op(id: 1, kind: 'release', stage: 'ready'), op(id: 2, kind: 'run', status: 'failed', needsHuman: true)],
        watermark: wm,
        enabled: {NotifyCategory.distribution},
      );
      expect(c.length, 1);
      expect(c.single.category, NotifyCategory.distribution);
    });

    test('TestFlight の実行完了はタイトルでそれと分かる', () {
      const wm = NotifyWatermark(initialized: true, lastRunUpdatedMs: baseMs, lastOperationId: 0);
      final c = detectNotifications(
        runs: [run(number: 8, conclusion: 'success', updatedMs: baseMs + 1000, workflow: 'testflight.yml')],
        operations: const [],
        watermark: wm,
        enabled: NotifyCategory.values.toSet(),
      );
      expect(c.single.title, contains('TestFlight 送信'));
    });
  });

  testWidgets('履歴タブ：マージと TestFlight が具体的に並び、日付でまとまる', (t) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final s = serviceWith({
      'list_operations': {
        'ok': true,
        'operations': [
          {'id': 2, 'repo': 'loverhetoric-gif/Upbeater', 'kind': 'run', 'stage': 'created', 'status': 'ok', 'reason': null, 'needs_human': false, 'detail': {'workflow': 'testflight.yml', 'event': 'manual'}, 'created_at': now},
          {'id': 1, 'repo': 'loverhetoric-gif/Upbeater', 'kind': 'auto_merge', 'stage': 'merged', 'status': 'ok', 'reason': '検査が通ったためマージしました', 'needs_human': false, 'detail': {'pr_number': 41}, 'created_at': now - 60000},
        ],
      },
    });
    await t.pumpWidget(MaterialApp(theme: buildConsoleTheme(), home: Scaffold(body: ConsoleHistoryScreen(service: s))));
    await t.pumpAndSettle();
    expect(find.text('今日'), findsOneWidget);
    expect(find.text('TestFlight へ送信'), findsOneWidget);
    expect(find.text('自動マージ'), findsOneWidget);
    expect(find.text('検査が通ったためマージしました'), findsOneWidget);
    expect(find.textContaining('PR #41'), findsOneWidget);
    expect(find.text('Upbeater'), findsNWidgets(2));
    expect(t.takeException(), isNull);
  });

  testWidgets('設定画面：通知のオン／オフが保存され、テスト通知が送れる', (t) async {
    t.view.physicalSize = const Size(400, 1600);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final settings = NotificationSettings(MemorySecretStore());
    await settings.load();
    final sink = FakeSink();
    final s = serviceWith({});
    await t.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(body: ConsoleSettingsScreen(service: s, notifications: settings, notificationSink: sink)),
    ));
    await t.pumpAndSettle();
    expect(find.text('実行の完了'), findsOneWidget);
    expect(find.text('配布の完了'), findsOneWidget);
    expect(find.text('要対応の発生'), findsOneWidget);
    // 実行の完了をオフにする
    await t.tap(find.byType(Switch).first);
    await t.pumpAndSettle();
    expect(settings.runCompleted, isFalse);
    // テスト通知
    await t.tap(find.text('テスト通知を送る'));
    await t.pumpAndSettle();
    expect(sink.shown.length, 1);
    expect(sink.shown.single.$2, contains('テスト通知'));
    expect(t.takeException(), isNull);
  });
}
