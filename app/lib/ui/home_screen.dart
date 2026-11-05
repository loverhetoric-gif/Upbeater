import 'package:flutter/material.dart';

import '../app_service.dart';
import '../core/state.dart';
import 'theme.dart';

String _time(int? ms) {
  if (ms == null) return '—';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.month}/${d.day} ${two(d.hour)}:${two(d.minute)}';
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.service});
  final AppService service;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: service,
      builder: (context, _) {
        final t = Theme.of(context);
        final s = service.state;
        final apps = s.apps.entries.toList()
          ..sort((a, b) {
            final p = StatusStyle.of(a.value.status).priority.compareTo(StatusStyle.of(b.value.status).priority);
            return p != 0 ? p : a.value.name.compareTo(b.value.name);
          });
        return Scaffold(
          body: SafeArea(
            child: LayoutBuilder(builder: (context, c) {
              final columns = c.maxWidth >= 1200 ? 3 : (c.maxWidth >= 760 ? 2 : 1);
              final pad = c.maxWidth >= 760 ? 32.0 : 16.0;
              return RefreshIndicator(
                onRefresh: service.checkNow,
                child: CustomScrollView(slivers: [
                  SliverPadding(
                    padding: EdgeInsets.fromLTRB(pad, 20, pad, 8),
                    sliver: SliverToBoxAdapter(
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 1160),
                          child: _Header(service: service),
                        ),
                      ),
                    ),
                  ),
                  if (service.lastError != null)
                    SliverPadding(
                      padding: EdgeInsets.symmetric(horizontal: pad, vertical: 8),
                      sliver: SliverToBoxAdapter(child: _Notice(text: service.lastError!)),
                    ),
                  SliverPadding(
                    padding: EdgeInsets.fromLTRB(pad, 12, pad, 32),
                    sliver: apps.isEmpty
                        ? SliverToBoxAdapter(
                            child: Padding(
                              padding: const EdgeInsets.symmetric(vertical: 48),
                              child: Text('管理しているアプリはまだありません。Claude で register_app を実行すると、ここに表示されます。',
                                  textAlign: TextAlign.center, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                            ),
                          )
                        : SliverToBoxAdapter(
                            child: Center(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(maxWidth: 1160),
                                child: _Grid(columns: columns, children: [for (final e in apps) _AppCard(state: e.value)]),
                              ),
                            ),
                          ),
                  ),
                ]),
              );
            }),
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.service});
  final AppService service;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final s = service.state;
    final narrow = MediaQuery.sizeOf(context).width < 520;
    final title = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Upbeater', style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
      const SizedBox(height: 2),
      Text('${s.deviceName ?? '端末'} ・ 最終照合 ${_time(s.lastCheckAt)}', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
    ]);
    final button = FilledButton.icon(
      onPressed: service.busy ? null : service.checkNow,
      icon: service.busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2)) : const Icon(Icons.sync),
      label: Text(service.busy ? '照合中' : '今すぐ照合'),
    );
    final wifi = Row(mainAxisSize: MainAxisSize.min, children: [
      Text('Wi-Fi 接続時のみ取得', style: t.textTheme.bodyMedium),
      const SizedBox(width: 8),
      Switch(value: s.wifiOnly, onChanged: service.setWifiOnly),
    ]);
    if (narrow) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [title, const SizedBox(height: 16), button, const SizedBox(height: 8), Align(alignment: Alignment.centerLeft, child: wifi)]);
    }
    return Row(children: [Expanded(child: title), wifi, const SizedBox(width: 16), button]);
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: t.colorScheme.errorContainer, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Icon(Icons.cloud_off, color: t.colorScheme.onErrorContainer),
        const SizedBox(width: 10),
        Expanded(child: Text(text, style: TextStyle(color: t.colorScheme.onErrorContainer))),
      ]),
    );
  }
}

class _Grid extends StatelessWidget {
  const _Grid({required this.columns, required this.children});
  final int columns;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    const gap = 14.0;
    return LayoutBuilder(builder: (context, c) {
      final w = (c.maxWidth - gap * (columns - 1)) / columns;
      return Wrap(spacing: gap, runSpacing: gap, children: [for (final ch in children) SizedBox(width: w, child: ch)]);
    });
  }
}

class _AppCard extends StatelessWidget {
  const _AppCard({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final st = StatusStyle.of(state.status);
    final color = st.color(t.colorScheme);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text(state.name.isEmpty ? '名前なし' : state.name,
                  style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(999)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(st.icon, size: 16, color: color),
                const SizedBox(width: 4),
                Text(st.label, style: t.textTheme.labelMedium?.copyWith(color: color, fontWeight: FontWeight.w700)),
              ]),
            ),
          ]),
          const SizedBox(height: 14),
          Wrap(spacing: 20, runSpacing: 6, children: [
            _Fact(label: '現行の通番', value: state.currentSeq == 0 ? '未導入' : '${state.currentSeq}'),
            _Fact(label: '保持', value: state.kept.isEmpty ? '—' : state.kept.map((k) => k.seq).join('・')),
            _Fact(label: '更新', value: _time(state.updatedAt)),
          ]),
          if (state.message != null) ...[
            const SizedBox(height: 12),
            Text(state.message!, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ],
        ]),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.onSurfaceVariant)),
      Text(value, style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, fontFeatures: const [FontFeature.tabularFigures()])),
    ]);
  }
}
