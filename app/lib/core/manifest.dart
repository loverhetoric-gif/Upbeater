/// マニフェストの署名検証と適用可否の判定。
/// Hub の `hub/src/manifest.ts`（acceptManifest）と同じ規則で判定する。
library;

import 'dart:convert';

import 'package:cryptography/cryptography.dart';

const manifestVersion = 1;

class SignedManifest {
  SignedManifest({required this.payload, required this.signature, required this.keyGeneration});

  factory SignedManifest.fromJson(Map<String, dynamic> j) => SignedManifest(
        payload: j['payload'] as String,
        signature: j['signature'] as String,
        keyGeneration: (j['key_generation'] as num).toInt(),
      );

  final String payload;
  final String signature;
  final int keyGeneration;
}

class ManifestBody {
  ManifestBody({
    required this.appId,
    required this.os,
    required this.seq,
    required this.commitSha,
    required this.releaseId,
    required this.sha256,
    required this.size,
    required this.url,
    required this.issuedAt,
    required this.expiresAt,
    required this.keyGeneration,
    this.rollbackToSeq,
    this.install = const {},
  });

  static ManifestBody? tryParse(Map<String, dynamic> j) {
    try {
      final rb = j['rollback'];
      return ManifestBody(
        appId: j['app_id'] as String,
        os: j['os'] as String,
        seq: (j['seq'] as num).toInt(),
        commitSha: j['commit_sha'] as String,
        releaseId: j['release_id'] as String,
        sha256: j['sha256'] as String,
        size: (j['size'] as num).toInt(),
        url: j['url'] as String,
        issuedAt: (j['issued_at'] as num).toInt(),
        expiresAt: (j['expires_at'] as num).toInt(),
        keyGeneration: (j['key_generation'] as num).toInt(),
        rollbackToSeq: rb is Map ? (rb['to_seq'] as num).toInt() : null,
        install: j['install'] is Map ? Map<String, dynamic>.from(j['install'] as Map) : const {},
      );
    } catch (_) {
      return null;
    }
  }

  final String appId;
  final String os;
  final int seq;
  final String commitSha;
  final String releaseId;
  final String sha256;
  final int size;
  final String url;
  final int issuedAt;
  final int expiresAt;
  final int keyGeneration;
  final int? rollbackToSeq;
  final Map<String, dynamic> install;

  String? installString(String key) => install[key] is String ? install[key] as String : null;
}

/// 端末が信頼する公開鍵（世代番号 → Ed25519 の公開鍵 x）と失効した世代
class TrustedKeys {
  TrustedKeys(this.keys, [Set<int>? revoked]) : revoked = revoked ?? {};

  /// アプリに埋め込んだ鍵（`--dart-define=UPBEATER_PUBLIC_KEYS={"1":"<x>",...}`）
  factory TrustedKeys.embedded() {
    const raw = String.fromEnvironment('UPBEATER_PUBLIC_KEYS');
    const revokedRaw = String.fromEnvironment('UPBEATER_REVOKED_GENERATIONS');
    final keys = <int, String>{};
    if (raw.isNotEmpty) {
      (jsonDecode(raw) as Map<String, dynamic>).forEach((k, v) => keys[int.parse(k)] = v as String);
    }
    return TrustedKeys(keys, revokedRaw.split(',').map((s) => int.tryParse(s.trim())).whereType<int>().toSet());
  }

  final Map<int, String> keys;
  final Set<int> revoked;

  bool get isEmpty => keys.isEmpty;

  /// Hub が失効を知らせた世代を加える（狭めるだけで、新しい鍵は受け入れない）
  TrustedKeys withRevoked(Iterable<int> more) => TrustedKeys(keys, {...revoked, ...more});
}

sealed class ManifestResult {}

class ManifestAccepted extends ManifestResult {
  ManifestAccepted(this.body, this.isRollback);
  final ManifestBody body;
  final bool isRollback;
}

class ManifestRejected extends ManifestResult {
  ManifestRejected(this.reason);

  /// revoked_key・unknown_key・malformed・bad_signature・wrong_app・wrong_os・expired・same_version・downgrade
  final String reason;

  @override
  String toString() => 'ManifestRejected($reason)';
}

List<int> _b64url(String s) => base64Url.decode(base64Url.normalize(s));

/// 署名の検証と、適用してよいかの判定
Future<ManifestResult> acceptManifest(
  SignedManifest signed,
  TrustedKeys trusted, {
  required String appId,
  required String os,
  required int currentSeq,
  required int nowMs,
}) async {
  if (trusted.revoked.contains(signed.keyGeneration)) return ManifestRejected('revoked_key');
  final x = trusted.keys[signed.keyGeneration];
  if (x == null) return ManifestRejected('unknown_key');
  List<int> payload;
  List<int> sig;
  try {
    payload = _b64url(signed.payload);
    sig = _b64url(signed.signature);
  } catch (_) {
    return ManifestRejected('malformed');
  }
  bool valid;
  try {
    valid = await Ed25519().verify(
      payload,
      signature: Signature(sig, publicKey: SimplePublicKey(_b64url(x), type: KeyPairType.ed25519)),
    );
  } catch (_) {
    valid = false;
  }
  if (!valid) return ManifestRejected('bad_signature');

  Map<String, dynamic> json;
  try {
    json = jsonDecode(utf8.decode(payload)) as Map<String, dynamic>;
  } catch (_) {
    return ManifestRejected('malformed');
  }
  final body = ManifestBody.tryParse(json);
  // 署名に含まれる世代と外側の世代が食い違うものは拒否する
  if (body == null || json['v'] != manifestVersion || body.keyGeneration != signed.keyGeneration) {
    return ManifestRejected('malformed');
  }
  if (body.appId != appId) return ManifestRejected('wrong_app');
  if (body.os != os) return ManifestRejected('wrong_os');
  if (!(body.expiresAt > nowMs)) return ManifestRejected('expired');
  if (body.seq > currentSeq) return ManifestAccepted(body, false);
  if (body.seq == currentSeq) return ManifestRejected('same_version');
  // 通番が現行より小さい版は、署名に含まれた巻き戻し指示がない限り無効（古い版へのすり替え対策）
  if (body.rollbackToSeq != null && body.rollbackToSeq == body.seq) return ManifestAccepted(body, true);
  return ManifestRejected('downgrade');
}
