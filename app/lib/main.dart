import 'dart:io';

import 'package:flutter/material.dart';

import 'app_service.dart';
import 'console_service.dart';
import 'ui/console_home.dart';
import 'ui/home_screen.dart';
import 'ui/register_screen.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // iOS では受け手の導入処理が対象外（OS の仕組みで他のアプリを入れられない）ため、
  // 管理画面だけのアプリとして起動する。AppService は iOS 用の部品が無く作れない
  if (Platform.isIOS) {
    final console = ConsoleService(secrets: SecureSecretStore());
    await console.init();
    runApp(UpbeaterConsoleApp(service: console));
    return;
  }
  final service = await AppService.create();
  await service.init();
  final console = ConsoleService(
    secrets: SecureSecretStore(),
    defaultHubUrl: service.state.hubUrl ?? ConsoleService.defaultConsoleHubUrl,
  );
  await console.init();
  runApp(UpbeaterApp(service: service, consoleService: console));
}

/// iOS 用：管理画面だけのアプリ
class UpbeaterConsoleApp extends StatelessWidget {
  const UpbeaterConsoleApp({super.key, required this.service});
  final ConsoleService service;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Upbeater',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: ConsoleLockGate(service: service),
    );
  }
}

class UpbeaterApp extends StatefulWidget {
  const UpbeaterApp({super.key, required this.service, required this.consoleService});
  final AppService service;
  final ConsoleService consoleService;

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
            ? HomeScreen(service: widget.service, consoleService: widget.consoleService)
            : RegisterScreen(service: widget.service, defaultName: Platform.localHostname),
      ),
    );
  }
}
