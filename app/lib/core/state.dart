/// 端末の状態（アプリごとの版・保持している成果物・失敗の回数・設定）。JSON ファイルに保存する。
/// 端末トークンは秘密情報のため、ここではなく SecretStore（OS の安全な保管場所）に置く。
library;

import 'dart:convert';
import 'dart:io';

class KeptVersion {
  KeptVersion({required this.seq, required this.sha256, required this.file, required this.commitSha, this.install = const {}});
  factory KeptVersion.fromJson(Map<String, dynamic> j) => KeptVersion(
        seq: (j['seq'] as num).toInt(),
        sha256: j['sha256'] as String,
        file: j['file'] as String,
        commitSha: j['commit_sha'] as String? ?? '',
        install: j['install'] is Map ? Map<String, dynamic>.from(j['install'] as Map) : const {},
      );
  final int seq;
  final String sha256;
  final String file;
  final String commitSha;
  final Map<String, dynamic> install;
  Map<String, dynamic> toJson() => {'seq': seq, 'sha256': sha256, 'file': file, 'commit_sha': commitSha, 'install': install};
}

class AppState {
  AppState({this.name = '', this.currentSeq = 0, List<KeptVersion>? kept, Map<int, int>? failures, this.status = 'idle', this.message, this.updatedAt})
      : kept = kept ?? [],
        failures = failures ?? {};

  factory AppState.fromJson(Map<String, dynamic> j) => AppState(
        name: j['name'] as String? ?? '',
        currentSeq: (j['current_seq'] as num?)?.toInt() ?? 0,
        kept: ((j['kept'] as List?) ?? const []).cast<Map<String, dynamic>>().map(KeptVersion.fromJson).toList(),
        failures: ((j['failures'] as Map?) ?? const {}).map((k, v) => MapEntry(int.parse(k as String), (v as num).toInt())),
        status: j['status'] as String? ?? 'idle',
        message: j['message'] as String?,
        updatedAt: (j['updated_at'] as num?)?.toInt(),
      );

  String name;
  int currentSeq;

  /// 直近 2 つの版（先頭が現行）。失敗・起動しない時はひとつ前に戻す
  List<KeptVersion> kept;

  /// 通番ごとの失敗の回数（同じ版を何度も試さない）
  Map<int, int> failures;

  /// idle・up_to_date・downloading・installing・installed・deferred・failed・rolled_back・rejected
  String status;
  String? message;
  int? updatedAt;

  Map<String, dynamic> toJson() => {
        'name': name,
        'current_seq': currentSeq,
        'kept': kept.map((k) => k.toJson()).toList(),
        'failures': failures.map((k, v) => MapEntry('$k', v)),
        'status': status,
        if (message != null) 'message': message,
        if (updatedAt != null) 'updated_at': updatedAt,
      };
}

class DeviceState {
  DeviceState({this.hubUrl, this.deviceId, this.deviceName, this.wifiOnly = false, this.lastCheckAt, Map<String, AppState>? apps}) : apps = apps ?? {};

  factory DeviceState.fromJson(Map<String, dynamic> j) => DeviceState(
        hubUrl: j['hub_url'] as String?,
        deviceId: j['device_id'] as String?,
        deviceName: j['device_name'] as String?,
        wifiOnly: j['wifi_only'] == true,
        lastCheckAt: (j['last_check_at'] as num?)?.toInt(),
        apps: ((j['apps'] as Map?) ?? const {}).map((k, v) => MapEntry(k as String, AppState.fromJson(Map<String, dynamic>.from(v as Map)))),
      );

  String? hubUrl;
  String? deviceId;
  String? deviceName;
  bool wifiOnly;
  int? lastCheckAt;
  final Map<String, AppState> apps;

  bool get registered => hubUrl != null && deviceId != null;

  AppState app(String id) => apps.putIfAbsent(id, AppState.new);

  Map<String, dynamic> toJson() => {
        if (hubUrl != null) 'hub_url': hubUrl,
        if (deviceId != null) 'device_id': deviceId,
        if (deviceName != null) 'device_name': deviceName,
        'wifi_only': wifiOnly,
        if (lastCheckAt != null) 'last_check_at': lastCheckAt,
        'apps': apps.map((k, v) => MapEntry(k, v.toJson())),
      };
}

class StateStore {
  StateStore(this.file);
  final File file;

  Future<DeviceState> load() async {
    try {
      if (await file.exists()) return DeviceState.fromJson(jsonDecode(await file.readAsString()) as Map<String, dynamic>);
    } catch (_) {
      // 壊れていたら初期状態から（端末の動作は止めない）
    }
    return DeviceState();
  }

  /// 一時ファイルに書いてから置き換える（書き込みの途中で落ちても壊れない）
  Future<void> save(DeviceState s) async {
    await file.parent.create(recursive: true);
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(const JsonEncoder.withIndent('  ').convert(s.toJson()), flush: true);
    await tmp.rename(file.path);
  }
}

/// 秘密情報（端末トークン）の保管場所
abstract class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class MemorySecretStore implements SecretStore {
  final Map<String, String> _m = {};
  @override
  Future<String?> read(String key) async => _m[key];
  @override
  Future<void> write(String key, String value) async => _m[key] = value;
  @override
  Future<void> delete(String key) async => _m.remove(key);
}
