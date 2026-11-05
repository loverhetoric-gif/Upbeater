import 'dart:io';

import 'package:flutter/material.dart';

import 'app_service.dart';
import 'ui/home_screen.dart';
import 'ui/register_screen.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final service = await AppService.create();
  await service.init();
  runApp(UpbeaterApp(service: service));
}

class UpbeaterApp extends StatefulWidget {
  const UpbeaterApp({super.key, required this.service});
  final AppService service;

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
            ? HomeScreen(service: widget.service)
            : RegisterScreen(service: widget.service, defaultName: Platform.localHostname),
      ),
    );
  }
}
