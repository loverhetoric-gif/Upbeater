/// 管理画面が使う Hub の道具の返り値のモデル。フィールドは hub/src/tools.ts の実装に合わせる。
/// 時刻はすべてミリ秒（Unix epoch ms）
library;

String _s(Object? v) => v?.toString() ?? '';
int _n(Object? v) => v is num ? v.toInt() : 0;

DateTime? timeOf(Object? v) {
  final ms = _n(v);
  return ms == 0 ? null : DateTime.fromMillisecondsSinceEpoch(ms);
}

/// 時刻の表示（例 11/25 14:03）。受け手の画面の _time と同じ形式
String formatTime(DateTime? t) {
  if (t == null) return '—';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.month}/${t.day} ${two(t.hour)}:${two(t.minute)}';
}

List<T> _list<T>(Object? v, T Function(Map<String, dynamic>) from) =>
    ((v as List?) ?? const []).whereType<Map<String, dynamic>>().map(from).toList();

/// list_repos の1件
class RepoItem {
  RepoItem.fromJson(Map<String, dynamic> j)
      : fullName = _s(j['repo']),
        defaultBranch = _s(j['default_branch']),
        paused = j['paused'] == true,
        lastRun = j['last_run'] is Map<String, dynamic> ? LastRun.fromJson(j['last_run'] as Map<String, dynamic>) : null;
  final String fullName;
  final String defaultBranch;
  final bool paused;
  final LastRun? lastRun;
}

class LastRun {
  LastRun.fromJson(Map<String, dynamic> j)
      : number = _n(j['number']),
        workflow = _s(j['workflow']),
        status = _s(j['status']),
        conclusion = j['conclusion'] as String?,
        createdAt = timeOf(j['created_at']);
  final int number;
  final String workflow;
  final String status;
  final String? conclusion;
  final DateTime? createdAt;
}

/// list_runs の1件
class RunItem {
  RunItem.fromJson(Map<String, dynamic> j)
      : runId = _s(j['run_id']),
        repo = _s(j['repo']),
        number = _n(j['number']),
        workflow = _s(j['workflow']),
        event = _s(j['event']),
        branch = _s(j['branch']),
        status = _s(j['status']),
        conclusion = j['conclusion'] as String?,
        createdAt = timeOf(j['created_at']),
        updatedAt = timeOf(j['updated_at']);
  final String runId;
  final String repo;
  final int number;
  final String workflow;
  final String event;
  final String branch;

  /// queued / running / completed
  final String status;

  /// success / failure / cancelled / definition_error
  final String? conclusion;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  bool get isActive => status == 'running' || status == 'queued';
  bool get isFailure => conclusion == 'failure' || conclusion == 'definition_error';

  /// 開始から最終更新までの時間（完了していれば所要時間）
  Duration? get duration {
    if (createdAt == null || updatedAt == null) return null;
    final d = updatedAt!.difference(createdAt!);
    return d.isNegative ? null : d;
  }
}

/// get_run の手順
class StepItem {
  StepItem.fromJson(Map<String, dynamic> j)
      : name = _s(j['name']),
        status = _s(j['status']),
        exitCode = j['exit_code'] is num ? (j['exit_code'] as num).toInt() : null,
        startedAt = timeOf(j['started_at']),
        finishedAt = timeOf(j['finished_at']);
  final String name;
  final String status;
  final int? exitCode;
  final DateTime? startedAt;
  final DateTime? finishedAt;

  Duration? get duration {
    if (startedAt == null || finishedAt == null) return null;
    final d = finishedAt!.difference(startedAt!);
    return d.isNegative ? null : d;
  }
}

/// get_run のジョブ
class JobItem {
  JobItem.fromJson(Map<String, dynamic> j)
      : jobId = _s(j['job_id']),
        name = _s(j['name']),
        status = _s(j['status']),
        reason = j['reason'] as String?,
        attempt = _n(j['attempt']),
        runner = j['runner'] as String?,
        claimedAt = timeOf(j['claimed_at']),
        finishedAt = timeOf(j['finished_at']),
        steps = _list(j['steps'], StepItem.fromJson);
  final String jobId;
  final String name;
  final String status;
  final String? reason;
  final int attempt;
  final String? runner;
  final DateTime? claimedAt;
  final DateTime? finishedAt;
  final List<StepItem> steps;

  Duration? get duration {
    if (claimedAt == null || finishedAt == null) return null;
    final d = finishedAt!.difference(claimedAt!);
    return d.isNegative ? null : d;
  }
}

/// get_run の全体
class RunDetail {
  RunDetail.fromJson(Map<String, dynamic> payload)
      : run = RunItem.fromJson(payload['run'] as Map<String, dynamic>? ?? const {}),
        jobs = _list(payload['jobs'], JobItem.fromJson);
  final RunItem run;
  final List<JobItem> jobs;
}

/// list_devices の1件
class DeviceItem {
  DeviceItem.fromJson(Map<String, dynamic> j)
      : id = _s(j['id']),
        name = _s(j['name']),
        os = _s(j['os']),
        lastSeenAt = timeOf(j['last_seen_at']),
        deviceKey = j['device_key'] as String?;
  final String id;
  final String name;
  final String os;
  final DateTime? lastSeenAt;
  final String? deviceKey;
}

/// get_install_status の配布できる版
class ReleaseItem {
  ReleaseItem.fromJson(Map<String, dynamic> j)
      : platform = _s(j['platform']),
        seq = _n(j['seq']),
        status = _s(j['status']),
        filename = _s(j['filename']),
        createdAt = timeOf(j['created_at']);
  final String platform;
  final int seq;

  /// ready / halted
  final String status;
  final String filename;
  final DateTime? createdAt;
}

/// get_install_status の OS ごとの設定
class DistSetting {
  DistSetting.fromJson(Map<String, dynamic> j)
      : platform = _s(j['platform']),
        paused = j['paused'] == 1 || j['paused'] == true,
        pinnedSeq = j['pinned_seq'] is num ? (j['pinned_seq'] as num).toInt() : null,
        staged = j['staged'] == 1 || j['staged'] == true;
  final String platform;
  final bool paused;
  final int? pinnedSeq;
  final bool staged;
}

/// get_install_status の端末ごとの導入状況
class InstallItem {
  InstallItem.fromJson(Map<String, dynamic> j)
      : device = _s(j['device']),
        os = _s(j['os']),
        seq = _n(j['seq']),
        status = _s(j['status']),
        message = j['message'] as String?,
        updatedAt = timeOf(j['updated_at']),
        targeted = j['targeted'] == true;
  final String device;
  final String os;
  final int seq;
  final String status;
  final String? message;
  final DateTime? updatedAt;
  final bool targeted;
}

class InstallStatus {
  InstallStatus.fromJson(Map<String, dynamic> payload)
      : repo = _s(payload['repo']),
        releases = _list(payload['releases'], ReleaseItem.fromJson),
        settings = _list(payload['settings'], DistSetting.fromJson),
        devices = _list(payload['devices'], InstallItem.fromJson);
  final String repo;
  final List<ReleaseItem> releases;
  final List<DistSetting> settings;
  final List<InstallItem> devices;

  /// OS ごとの最新の ready な版
  ReleaseItem? latestReady(String platform) {
    for (final r in releases) {
      if (r.platform == platform && r.status == 'ready') return r;
    }
    return null;
  }

  DistSetting? settingOf(String platform) {
    for (final s in settings) {
      if (s.platform == platform) return s;
    }
    return null;
  }
}

/// list_operations の1件
class OperationItem {
  OperationItem.fromJson(Map<String, dynamic> j)
      : id = _n(j['id']),
        repo = j['repo'] as String?,
        runId = j['run_id'] as String?,
        jobId = j['job_id'] as String?,
        kind = _s(j['kind']),
        stage = _s(j['stage']),
        status = _s(j['status']),
        reason = j['reason'] as String?,
        retryable = j['retryable'] == true,
        needsHuman = j['needs_human'] == true,
        detail = j['detail'] is Map<String, dynamic> ? j['detail'] as Map<String, dynamic> : const {},
        createdAt = timeOf(j['created_at']);
  final int id;
  final String? repo;
  final String? runId;
  final String? jobId;
  final String kind;
  final String stage;
  final String status;
  final String? reason;
  final bool retryable;
  final bool needsHuman;

  /// 詳細（ワークフロー名・版・ビルド番号など。Hub が JSON で持つ）
  final Map<String, dynamic> detail;
  final DateTime? createdAt;
}
