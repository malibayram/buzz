import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/huddle/huddle.dart';
import '../../shared/theme/theme.dart';

/// Camera toggle and remote video tiles for the huddle call sheet.
class HuddleVideoStage extends HookConsumerWidget {
  const HuddleVideoStage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final video = ref.watch(huddleVideoProvider);
    final screen = video.tiles.where(
      (tile) =>
          tile.track == HuddleVideoWire.trackScreen && tile.textureId != null,
    );
    final cameras = video.tiles.where(
      (tile) =>
          tile.track == HuddleVideoWire.trackCamera && tile.textureId != null,
    );
    final spotlight = screen.isEmpty ? null : screen.first;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (spotlight != null)
          _HuddleVideoTexture(
            key: const ValueKey('huddle-screen-spotlight'),
            label: 'Screen from ${spotlight.pubkey}',
            textureId: spotlight.textureId!,
            height: 180,
          ),
        if (cameras.isNotEmpty)
          SizedBox(
            height: 96,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                for (final tile in cameras)
                  _HuddleVideoTexture(
                    key: ValueKey('huddle-video-tile-${tile.key}'),
                    label: 'Camera from ${tile.pubkey}',
                    textureId: tile.textureId!,
                    height: 96,
                    width: 128,
                  ),
              ],
            ),
          ),
        if (video.error != null)
          Text(video.error!, key: const ValueKey('huddle-video-error')),
        IconButton(
          key: const ValueKey('huddle-camera-toggle'),
          tooltip: video.cameraOn ? 'Turn camera off' : 'Turn camera on',
          isSelected: video.cameraOn,
          onPressed: () =>
              unawaited(ref.read(huddleVideoProvider.notifier).toggleCamera()),
          icon: Icon(
            video.cameraOn ? LucideIcons.videoOff : LucideIcons.video,
            color: video.cameraOn
                ? context.colors.onPrimary
                : context.colors.onSurface,
          ),
        ),
      ],
    );
  }
}

class _HuddleVideoTexture extends StatelessWidget {
  const _HuddleVideoTexture({
    super.key,
    required this.label,
    required this.textureId,
    required this.height,
    this.width,
  });

  final String label;
  final int textureId;
  final double height;
  final double? width;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      image: true,
      child: SizedBox(
        width: width ?? double.infinity,
        height: height,
        child: Texture(textureId: textureId),
      ),
    );
  }
}
