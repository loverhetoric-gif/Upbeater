/// アプリ全体をつなぐ：状態の読み込み、登録、照合（起動時・復帰時・定期）、画面への通知
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import 'core/hub_client.dart';
import 'core/manifest.dart';
import 'core/platform.dart';
import 'core/state.dart';
import 'core/updater.dart';
import 'platform/android.dart';
import 'platform/common.dart';
import 'platform/macos.dart';

const _tokenKey = 'upbeater.device_token';

class SecureSecretStore implements SecretStore {
  // macOS は開発チームの署名が無くても使える従来の保管場所を使う
  final _s = const FlutterSecureStorage(mOptions: MacOsOptions(usesDataProtectionKeychain: false));
  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

/// OS ごとの部品
class PlatformParts {
  PlatformParts({required this.installer, required this.disk, required this.network});
  final Installer installer;
  final DiskSpace disk;
  final NetworkPolicy network;

  static PlatformParts forCurrent(Directory work) {
    if (Platform.isAndroid) return PlatformParts(installer: AndroidInstaller(), disk: AndroidDiskSpace(), network: ConnectivityPolicy());
    if (Platform.isMacOS) {
      return PlatformParts(installer: MacosInstaller(workDir: work, onSelfUpdate: () => exit(0)), disk: MacosDiskSpace(), network: ConnectivityPolicy());
    }
    throw UnsupportedError('この OS にはまだ対応していません');
  }
}

class AppService extends ChangeNotifier {
  AppService({required this.root, required this.secrets, required this.parts, TrustedKeys? keys, this.interval = const Duration(minutes: 15)})
      : keys = keys ?? TrustedKeys.embedded(),
        store = StateStore(File('${root.path}/state.json'));

  static Future<AppService> create() async {
    final root = Directory('${(await getApplicationSupportDirectory()).path}/upbeater');
    return AppService(root: root, secrets: SecureSecretStore(), parts: PlatformParts.forCurrent(Directory('${root.path}/work')));
  }

  final Directory root;
  final SecretStore secrets;
  final PlatformParts parts;
  final TrustedKeys keys;
  final Duration interval;
  final StateStore store;

  DeviceState state = DeviceState();
  Updater? _updater;
  Timer? _timer;
  bool busy = false;
  String? lastError;

  bool get registered => state.registered && _updater != null;

  Future<void> init() async {
    state = await store.load();
    await _recoverSelfUpdate();
    final token = await secrets.read(_tokenKey);
    if (state.registered && token != null) {
      _wire(token);
      _timer = Timer.periodic(interval, (_) => checkNow());
      unawaited(checkNow());
    }
    notifyListeners();
  }

  /// macOS の自己更新が失敗して前の版に戻った場合、状態を前の版に合わせる
  Future<void> _recoverSelfUpdate() async {
    final mark = File('${root.path}/work/self-update-failed');
    if (!await mark.exists()) return;
    await mark.delete();
    for (final s in state.apps.values) {
      // 自己更新した版（Upbeater 自身のバンドル ID）だけを対象にする
      if (s.kept.length >= 2 && s.kept.first.install['bundle_id'] == 'com.upbeater.upbeater') {
        final failed = s.kept.first;
        s.failures[failed.seq] = Updater.maxFailuresPerSeq;
        s.kept = s.kept.skip(1).toList();
        s.currentSeq = s.kept.first.seq;
        s.status = 'rolled_back';
        s.message = '通番 ${failed.seq} の起動を確認できなかったため、前の版に戻しました';
      }
    }
    await store.save(state);
  }

  void _wire(String token) {
    _updater = Updater(
      hub: HubClient(Uri.parse(state.hubUrl!), token: token),
      store: store,
      state: state,
      keys: keys,
      installer: parts.installer,
      disk: parts.disk,
      network: parts.network,
      versionsDir: Directory('${root.path}/versions'),
    );
  }

  Future<void> register({required String hubUrl, required String code, required String name}) async {
    final base = Uri.parse(hubUrl.trim().replaceAll(RegExp(r'/+$'), ''));
    final reg = await HubClient(base).register(code: code.trim(), name: name.trim(), os: parts.installer.os);
    await secrets.write(_tokenKey, reg.token);
    state
      ..hubUrl = base.toString()
      ..deviceId = reg.deviceId
      ..deviceName = name.trim();
    await store.save(state);
    _wire(reg.token);
    _timer?.cancel();
    _timer = Timer.periodic(interval, (_) => checkNow());
    notifyListeners();
    unawaited(checkNow());
  }

  Future<void> checkNow() async {
    final u = _updater;
    if (u == null || busy) return;
    busy = true;
    lastError = null;
    notifyListeners();
    try {
      final r = await u.checkAll();
      if (r.values.isNotEmpty && r.values.every((o) => o == Outcome.hubUnreachable)) lastError = 'Hub に接続できません。現在の版のまま動作を続けます';
    } catch (e) {
      lastError = '照合に失敗しました：$e';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> setWifiOnly(bool v) async {
    state.wifiOnly = v;
    await store.save(state);
    notifyListeners();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
