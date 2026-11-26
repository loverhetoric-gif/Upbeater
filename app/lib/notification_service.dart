/// 完了通知まわり：設定の保存、ローカル通知への橋渡し、ポーリングによる差分検出、
/// iOS のバックグラウンド更新（BGAppRefresh）の入り口。
///
/// 割り切り（このプロダクトにはプッシュ基盤が無い）：
/// - 検知はポーリング方式。アプリ使用中は60秒間隔、復帰時は即時、加えて iOS の
///   BGAppRefresh に定期確認を登録する
/// - BGAppRefresh の実行間隔は OS が決めるため保証されない（数十分〜数時間空くこともある）。
///   「終わったらすぐ鳴る」ではなく「次に確認した時点で鳴る」が仕様
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:workmanager/workmanager.dart';

import 'app_service.dart';
import 'console_service.dart';
import 'core/notification_logic.dart';
import 'core/state.dart';

/// iOS の BGTaskScheduler に登録するタスク ID（Info.plist の
/// BGTaskSchedulerPermittedIdentifiers と AppDelegate の登録と一致させること）
const consoleRefreshTaskId = 'com.upbeater.console.refresh';
const consoleRefreshTaskName = 'consoleRefresh';

/// 通知の設定（分類ごとのオン／オフ）と透かしの保存先。
/// 接続の控えと同じ SecretStore（OS の安全な保管場所）に寄せる
class NotificationSettings extends ChangeNotifier {
  NotificationSettings(this.store);

  final SecretStore store;

  static const _prefix = 'upbeater.console_notify.';
  static const _wmPrefix = 'upbeater.console_watermark.';

  bool runCompleted = true;
  bool distribution = true;
  bool attention = true;

  NotifyWatermark _watermark = const NotifyWatermark();
  NotifyWatermark get watermark => _watermark;

  Set<NotifyCategory> get enabledCategories => {
        if (runCompleted) NotifyCategory.runCompleted,
        if (distribution) NotifyCategory.distribution,
        if (attention) NotifyCategory.attention,
      };

  bool isEnabled(NotifyCategory c) => enabledCategories.contains(c);

  static String _flagKey(NotifyCategory c) => '$_prefix${c.name}';

  Future<void> load() async {
    Future<bool> flag(NotifyCategory c, bool fallback) async {
      final v = await store.read(_flagKey(c));
      return v == null ? fallback : v == '1';
    }

    runCompleted = await flag(NotifyCategory.runCompleted, true);
    distribution = await flag(NotifyCategory.distribution, true);
    attention = await flag(NotifyCategory.attention, true);
    final init = await store.read('${_wmPrefix}initialized');
    final runMs = int.tryParse(await store.read('${_wmPrefix}run_ms') ?? '') ?? 0;
    final opId = int.tryParse(await store.read('${_wmPrefix}op_id') ?? '') ?? 0;
    _watermark = NotifyWatermark(initialized: init == '1', lastRunUpdatedMs: runMs, lastOperationId: opId);
    notifyListeners();
  }

  Future<void> setCategory(NotifyCategory c, bool value) async {
    switch (c) {
      case NotifyCategory.runCompleted:
        runCompleted = value;
      case NotifyCategory.distribution:
        distribution = value;
      case NotifyCategory.attention:
        attention = value;
    }
    await store.write(_flagKey(c), value ? '1' : '0');
    notifyListeners();
  }

  Future<void> saveWatermark(NotifyWatermark wm) async {
    _watermark = wm;
    await store.write('${_wmPrefix}initialized', wm.initialized ? '1' : '0');
    await store.write('${_wmPrefix}run_ms', '${wm.lastRunUpdatedMs}');
    await store.write('${_wmPrefix}op_id', '${wm.lastOperationId}');
  }
}

/// 通知の送信口。テストでは差し替える
abstract class NotificationSink {
  Future<void> init();
  Future<void> requestPermission();
  Future<void> show({required NotifyCategory category, required int id, required String title, required String body});
}

/// flutter_local_notifications への実送信口
class LocalNotificationSink implements NotificationSink {
  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  static (String, String) _channel(NotifyCategory c) => switch (c) {
        NotifyCategory.runCompleted => ('upbeater_run_completed', '実行の完了'),
        NotifyCategory.distribution => ('upbeater_distribution', '配布'),
        NotifyCategory.attention => ('upbeater_attention', '要対応'),
      };

  @override
  Future<void> init() async {
    if (_ready) return;
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
        macOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
      ),
    );
    _ready = true;
  }

  @override
  Future<void> requestPermission() async {
    await init();
    await _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, badge: true, sound: true);
    await _plugin.resolvePlatformSpecificImplementation<MacOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, badge: true, sound: true);
    await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
  }

  @override
  Future<void> show({required NotifyCategory category, required int id, required String title, required String body}) async {
    await init();
    final (channelId, channelName) = _channel(category);
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(channelId, channelName, importance: Importance.high, priority: Priority.high),
        iOS: const DarwinNotificationDetails(),
        macOS: const DarwinNotificationDetails(),
      ),
    );
  }
}

/// ポーリングで Hub を確認し、新しい完了・配布・要対応だけを通知する
class ConsoleNotifier {
  ConsoleNotifier({required this.service, required this.settings, required this.sink});

  final ConsoleService service;
  final NotificationSettings settings;
  final NotificationSink sink;

  Timer? _timer;
  bool _checking = false;

  /// いま確認する。通知した件数を返す。初回は透かし合わせだけで通知しない
  Future<int> checkNow() async {
    if (_checking || !service.configured) return 0;
    _checking = true;
    try {
      await settings.load();
      final runs = await service.fetchRuns(limit: 50);
      final operations = await service.fetchOperations(limit: 100);
      final wm = settings.watermark;
      final candidates = detectNotifications(runs: runs, operations: operations, watermark: wm, enabled: settings.enabledCategories);
      for (final c in candidates) {
        await sink.show(category: c.category, id: c.notificationId, title: c.title, body: c.body);
      }
      await settings.saveWatermark(advanceWatermark(wm, runs, operations));
      return candidates.length;
    } finally {
      _checking = false;
    }
  }

  /// 使用中の定期確認（既定60秒）。多重起動はしない
  void startPolling({Duration interval = const Duration(seconds: 60)}) {
    if (_timer != null) return;
    _timer = Timer.periodic(interval, (_) => unawaited(_quietCheck()));
    unawaited(_quietCheck());
  }

  void stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _quietCheck() async {
    try {
      await checkNow();
    } catch (_) {
      // 定期確認の失敗は画面を騒がせない（次回に回す）
    }
  }
}

/// バックグラウンド側の確認（BGAppRefresh から呼ばれる）
Future<void> runConsoleBackgroundCheck() async {
  WidgetsFlutterBinding.ensureInitialized();
  final service = ConsoleService(secrets: SecureSecretStore());
  await service.init();
  if (!service.configured) return;
  final settings = NotificationSettings(service.secrets);
  final notifier = ConsoleNotifier(service: service, settings: settings, sink: LocalNotificationSink());
  await notifier.checkNow();
}

/// workmanager の入り口（別 isolate で動くため top-level で置く）
@pragma('vm:entry-point')
void consoleNotificationDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      await runConsoleBackgroundCheck();
    } catch (_) {
      // バックグラウンドでは失敗しても次回の起動に任せる
    }
    return true;
  });
}

/// iOS の BGAppRefresh に定期確認を登録する。
/// 実行間隔は OS が制御するため保証されない（Info.plist と AppDelegate の登録が前提）
Future<void> registerConsoleBackgroundRefresh() async {
  if (!Platform.isIOS) return;
  await Workmanager().initialize(consoleNotificationDispatcher);
  await Workmanager().registerPeriodicTask(
    consoleRefreshTaskId,
    consoleRefreshTaskName,
    frequency: const Duration(minutes: 15),
    initialDelay: const Duration(minutes: 15),
  );
}
