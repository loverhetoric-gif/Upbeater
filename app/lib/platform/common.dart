import 'package:connectivity_plus/connectivity_plus.dart';

import '../core/platform.dart';

/// Wi-Fi・有線を「従量制でない」とみなす
class ConnectivityPolicy implements NetworkPolicy {
  @override
  Future<bool> isUnmetered() async {
    final r = await Connectivity().checkConnectivity();
    return r.contains(ConnectivityResult.wifi) || r.contains(ConnectivityResult.ethernet);
  }
}
