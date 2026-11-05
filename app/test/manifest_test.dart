import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:upbeater/core/manifest.dart';

/// Hub（TypeScript）の signManifest で作った署名を、端末（Dart）で検証できることを確かめる
void main() {
  final v = jsonDecode(File('test/fixtures/manifests.json').readAsStringSync()) as Map<String, dynamic>;
  final pub = (v['public_keys'] as Map<String, dynamic>).map((k, x) => MapEntry(int.parse(k), (x as Map)['x'] as String));
  SignedManifest m(String name) => SignedManifest.fromJson(v[name] as Map<String, dynamic>);
  final now = DateTime.now().millisecondsSinceEpoch;
  Future<ManifestResult> accept(String name, {Set<int> gens = const {1, 2}, Set<int> revoked = const {}, int current = 4, String app = 'app1', String os = 'android'}) =>
      acceptManifest(m(name), TrustedKeys({for (final g in gens) g: pub[g]!}, {...revoked}), appId: app, os: os, currentSeq: current, nowMs: now);

  test('Hub の署名を検証でき、導入の設定も読める', () async {
    final r = await accept('update_gen2_seq5');
    expect(r, isA<ManifestAccepted>());
    final b = (r as ManifestAccepted).body;
    expect(b.seq, 5);
    expect(b.installString('package'), 'com.example.app');
    expect(r.isRollback, isFalse);
  });

  test('1 文字でも改ざんされた中身・署名は拒否する', () async {
    final o = m('update_gen2_seq5');
    final payload = base64Url.decode(base64Url.normalize(o.payload));
    payload[20] ^= 1;
    final tampered = SignedManifest(payload: base64Url.encode(payload).replaceAll('=', ''), signature: o.signature, keyGeneration: 2);
    final r = await acceptManifest(tampered, TrustedKeys({2: pub[2]!}), appId: 'app1', os: 'android', currentSeq: 0, nowMs: now);
    expect((r as ManifestRejected).reason, 'bad_signature');
    final swapped = SignedManifest(payload: o.payload, signature: o.signature, keyGeneration: 1);
    expect(((await acceptManifest(swapped, TrustedKeys(pub), appId: 'app1', os: 'android', currentSeq: 0, nowMs: now)) as ManifestRejected).reason,
        'bad_signature');
  });

  test('鍵の世代交代：複数世代を受け入れ、失効した世代と知らない世代は拒否する', () async {
    expect(await accept('update_gen1_seq5'), isA<ManifestAccepted>());
    expect(((await accept('update_gen1_seq5', revoked: {1})) as ManifestRejected).reason, 'revoked_key');
    expect(await accept('update_gen2_seq5', revoked: {1}), isA<ManifestAccepted>());
    expect(((await accept('update_gen3_seq6')) as ManifestRejected).reason, 'unknown_key');
    // Hub が知らせる失効は加えるだけで、新しい鍵は増やさない
    final k = TrustedKeys({2: pub[2]!}).withRevoked({2});
    expect(k.revoked, {2});
    expect(k.keys.keys, [2]);
  });

  test('古い版へのすり替えは、署名付きの巻き戻し指示がない限り拒否する', () async {
    expect(((await accept('old_gen2_seq3', current: 5)) as ManifestRejected).reason, 'downgrade');
    expect(((await accept('old_gen2_seq3', current: 3)) as ManifestRejected).reason, 'same_version');
    final rb = await accept('rollback_gen2_seq3', current: 5);
    expect((rb as ManifestAccepted).isRollback, isTrue);
  });

  test('期限切れ・別アプリ・別 OS は拒否する', () async {
    expect(((await accept('expired_gen2_seq7')) as ManifestRejected).reason, 'expired');
    expect(((await accept('update_gen2_seq5', app: 'other')) as ManifestRejected).reason, 'wrong_app');
    expect(((await accept('update_gen2_seq5', os: 'macos')) as ManifestRejected).reason, 'wrong_os');
  });
}
