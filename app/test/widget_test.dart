import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:upbeater/app_service.dart';
import 'package:upbeater/core/manifest.dart';
import 'package:upbeater/core/state.dart';
import 'package:upbeater/ui/home_screen.dart';
import 'package:upbeater/ui/register_screen.dart';
import 'package:upbeater/ui/theme.dart';

import 'support/fakes.dart';

/// スマホ・タブレット・PC の大きさで、はみ出し・崩れがないことを確かめる
const sizes = {'スマホ': Size(360, 740), 'タブレット': Size(820, 1180), 'PC': Size(1440, 900)};

AppService service() => AppService(
      root: Directory.systemTemp.createTempSync('upb-w-'),
      secrets: MemorySecretStore(),
      parts: PlatformParts(installer: FakeInstaller(), disk: FakeDisk(), network: FakeNetwork()),
      keys: TrustedKeys({}),
    );

Future<void> pump(WidgetTester t, Widget w, Size size, Brightness b) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(theme: buildTheme(b), home: w));
  await t.pump();
}

void main() {
  for (final e in sizes.entries) {
    for (final b in Brightness.values) {
      testWidgets('登録の画面（${e.key}・${b.name}）', (t) async {
        await pump(t, RegisterScreen(service: service(), defaultName: 'MacBook'), e.value, b);
        expect(find.text('端末を登録'), findsOneWidget);
        await t.tap(find.text('登録する'));
        await t.pump();
        expect(find.text('https で始まるアドレスを入力してください'), findsOneWidget);
        expect(find.text('10 文字のコードを入力してください'), findsOneWidget);
        expect(t.takeException(), isNull);
      });

      testWidgets('アプリの一覧（${e.key}・${b.name}）', (t) async {
        final s = service();
        s.state
          ..deviceName = '仕事用の MacBook Pro（とても長い名前の端末）'
          ..lastCheckAt = DateTime(2026, 11, 5, 9, 30).millisecondsSinceEpoch;
        s.state.apps['a'] = AppState(name: 'Widget', currentSeq: 12, status: 'installed', message: '通番 12 を導入しました')
          ..kept = [KeptVersion(seq: 12, sha256: 's', file: 'f', commitSha: 'c'), KeptVersion(seq: 11, sha256: 's', file: 'f', commitSha: 'c')];
        s.state.apps['b'] = AppState(name: 'とても長い名前のアプリケーションで折り返しを確かめる', status: 'deferred', message: '空き容量が足りません（必要 350 MB、空き 120 MB）');
        s.state.apps['c'] = AppState(name: 'Docs', status: 'failed', message: '成果物の照合に失敗しました');
        s.lastError = 'Hub に接続できません。現在の版のまま動作を続けます';
        await pump(t, HomeScreen(service: s), e.value, b);
        expect(find.text('Widget'), findsOneWidget);
        expect(find.text('保留'), findsOneWidget);
        expect(find.text('11・12'.split('・').reversed.join('・')), findsOneWidget);
        expect(t.takeException(), isNull);
      });
    }
  }
}
