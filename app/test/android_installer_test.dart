import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:upbeater/core/manifest.dart';
import 'package:upbeater/platform/android.dart';

/// Android の導入の判断を、模擬のネイティブ側（MethodChannel）で確かめる
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('upbeater/android');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  late Map<String, dynamic>? installed;
  late String? installedSha;
  late List<String> calls;
  const sha = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';

  setUp(() {
    calls = [];
    installed = null;
    installedSha = null;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      switch (call.method) {
        case 'archiveInfo':
          return {'package': 'com.example.app', 'versionCode': 7, 'signers': ['k1']};
        case 'installedInfo':
          return installed;
        case 'installedSha256':
          return installedSha;
        case 'install':
          return {'status': 'success'};
      }
      return null;
    });
  });

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  ManifestBody body() => ManifestBody(
        appId: 'a1',
        os: 'android',
        seq: 3,
        commitSha: 'c',
        releaseId: 'r',
        sha256: sha,
        size: 1,
        url: 'https://example.invalid/a',
        issuedAt: 0,
        expiresAt: 0,
        keyGeneration: 1,
        install: const {'package': 'com.example.app'},
      );

  final apk = File('${Directory.systemTemp.path}/upbeater-test.apk');

  test('入っていなければ導入する', () async {
    final r = await AndroidInstaller().install(apk, body());
    expect(r.ok, isTrue);
    expect(calls, contains('install'));
  });

  test('同じ成果物がすでに入っていれば、導入せずに導入済みとする（自分自身の更新の後など）', () async {
    installed = {'package': 'com.example.app', 'versionCode': 7, 'signers': ['k1']};
    installedSha = sha.toUpperCase();
    final r = await AndroidInstaller().install(apk, body());
    expect(r.ok, isTrue);
    expect(calls, isNot(contains('install')));
  });

  test('版が同じでも中身が違えば、導入しない', () async {
    installed = {'package': 'com.example.app', 'versionCode': 7, 'signers': ['k1']};
    installedSha = 'ff' * 32;
    final r = await AndroidInstaller().install(apk, body());
    expect(r.ok, isFalse);
    expect(r.message, contains('versionCode'));
    expect(calls, isNot(contains('install')));
  });

  test('署名鍵が違えば、同じ中身の照合より先に断る', () async {
    installed = {'package': 'com.example.app', 'versionCode': 6, 'signers': ['other']};
    installedSha = sha;
    final r = await AndroidInstaller().install(apk, body());
    expect(r.ok, isFalse);
    expect(r.message, contains('署名鍵'));
  });

  test('古い版が入っていれば更新する', () async {
    installed = {'package': 'com.example.app', 'versionCode': 6, 'signers': ['k1']};
    installedSha = 'ff' * 32;
    final r = await AndroidInstaller().install(apk, body());
    expect(r.ok, isTrue);
    expect(calls, contains('install'));
  });
}
