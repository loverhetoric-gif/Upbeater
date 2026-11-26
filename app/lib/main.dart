import 'dart:io';

import 'package:flutter/material.dart';

import 'app_service.dart';
import 'console_service.dart';
import 'notification_service.dart';
import 'ui/console_home.dart';
import 'ui/home_screen.dart';
import 'ui/register_screen.dart';
import 'ui/theme.dart';

/// 管理画面の完了通知の確認役を組み立てる
ConsoleNotifier buildConsoleNotifier(ConsoleService console) {
  return ConsoleNotifier(
    service: console,
    settings: NotificationSettings(console.secrets),
    sink: LocalNotificationSink(),
  );
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // iOS では受け手の導入処理が対象外（OS の仕組みで他のアプリを入れられない）ため、
  // 管理画面だけのアプリとして起動する。AppService は iOS 用の部品が無く作れない
  if (Platform.isIOS) {
    final console = ConsoleService(secrets: SecureSecretStore());
    await console.init();
    // バックグラウンド更新（BGAppRefresh）でも完了を確認する。
    // 実行間隔は OS が決めるため保証されない（ポーリングの補助と位置づける）
    await registerConsoleBackgroundRefresh();
    runApp(UpbeaterConsoleApp(service: console, notifier: buildConsoleNotifier(console)));
    return;
  }
  final service = await AppService.create();
  await service.init();
  final console = ConsoleService(
    secrets: SecureSecretStore(),
    defaultHubUrl: service.state.hubUrl ?? ConsoleService.defaultConsoleHubUrl,
  );
  await console.init();
  runApp(UpbeaterApp(service: service, consoleService: console, consoleNotifier: buildConsoleNotifier(console)));
}

/// iOS 用：管理画面だけのアプリ
class UpbeaterConsoleApp extends StatelessWidget {
  const UpbeaterConsoleApp({super.key, required this.service, this.notifier});
  final ConsoleService service;
  final ConsoleNotifier? notifier;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Upbeater',
      debugShowCheckedModeBanner: false,
      theme: buildConsoleTheme(),
      darkTheme: buildConsoleTheme(),
      home: ConsoleLockGate(service: service, notifier: notifier),
    );
  }
}

class UpbeaterApp extends StatefulWidget {
  const UpbeaterApp({super.key, required this.service, required this.consoleService, this.consoleNotifier});
  final AppService service;
  final ConsoleService consoleService;
  final ConsoleNotifier? consoleNotifier;

  @override
  State<UpbeaterApp> createState() => _UpbeaterAppState();
}

class _UpbeaterAppState extends State<UpbeaterApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// 復帰時に照合する（通知が届かなかった場合の保険）
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) widget.service.checkNow();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Upbeater',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: ListenableBuilder(
        listenable: widget.service,
        builder: (context, _) => widget.service.registered
            ? HomeScreen(service: widget.service, consoleService: widget.consoleService, consoleNotifier: widget.consoleNotifier)
            : RegisterScreen(service: widget.service, defaultName: Platform.localHostname),
      ),
    );
  }
}
