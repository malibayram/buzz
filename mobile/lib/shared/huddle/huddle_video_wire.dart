import 'dart:typed_data';

/// Video frames on `GET /huddle/{id}/video`. Audio stays on its own socket.
abstract final class HuddleVideoWire {
  static const codec = 'avc1.42E01F';
  static const trackCamera = 0;
  static const trackScreen = 1;
  static const headerLength = 12;
  static const relayPrefixLength = 2;
  static const keyframeFlag = 0x01;
  static const maxFrameLength = 512 * 1024;

  static Uint8List encodeClientFrame({
    required int track,
    required int layer,
    required bool keyframe,
    required int sequence,
    required int timestamp90k,
    required Uint8List annexB,
  }) {
    final length = headerLength + annexB.length;
    if (annexB.isEmpty || length > maxFrameLength) {
      throw HuddleVideoWireException('Video frame is $length bytes.');
    }
    final bytes = Uint8List(length);
    final view = ByteData.sublistView(bytes);
    bytes[0] = track;
    bytes[1] = layer;
    bytes[2] = keyframe ? keyframeFlag : 0;
    view.setUint32(4, sequence);
    view.setUint32(8, timestamp90k);
    bytes.setRange(headerLength, length, annexB);
    return bytes;
  }

  static HuddleVideoFrame decodeRelayFrame(Uint8List bytes) {
    final minimum = relayPrefixLength + headerLength + 1;
    if (bytes.length < minimum || bytes.length > maxFrameLength) {
      throw HuddleVideoWireException(
        'Relay video frame is ${bytes.length} bytes.',
      );
    }
    final view = ByteData.sublistView(bytes);
    return HuddleVideoFrame(
      peerIndex: bytes[0],
      epoch: bytes[1],
      track: bytes[2],
      layer: bytes[3],
      keyframe: (bytes[4] & keyframeFlag) != 0,
      sequence: view.getUint32(6),
      timestamp90k: view.getUint32(10),
      annexB: Uint8List.sublistView(bytes, relayPrefixLength + headerLength),
    );
  }

  static Map<String, Object> cameraPublish() => {
    'type': 'publish',
    'track': trackCamera,
    'codec': codec,
    'layers': [
      {'layer': 0, 'w': 640, 'h': 360, 'max_kbps': 600},
    ],
  };

  static Map<String, Object?> subscribe({
    required int peerIndex,
    required int epoch,
    required int track,
    required int? layer,
  }) => {
    'type': 'subscribe',
    'peer_index': peerIndex,
    'epoch': epoch,
    'track': track,
    'layer': layer,
  };

  static String errorText(String code) => switch (code) {
    'screen_share_busy' => 'Someone else is sharing their screen',
    'camera_limit' => 'This huddle already has 8 cameras',
    'frame_too_large' => 'A video frame was too large',
    'huddle_video_unavailable_on_mesh' => 'Video is unavailable on this server',
    'huddle_video_unavailable' => 'Video is turned off on this server',
    'video_requires_audio_peer' => 'Join huddle audio before turning on video',
    'unsupported_version' => 'This huddle is not using the video protocol',
    _ => 'Video is unavailable',
  };
}

final class HuddleVideoFrame {
  final int peerIndex;
  final int epoch;
  final int track;
  final int layer;
  final bool keyframe;
  final int sequence;
  final int timestamp90k;
  final Uint8List annexB;

  const HuddleVideoFrame({
    required this.peerIndex,
    required this.epoch,
    required this.track,
    required this.layer,
    required this.keyframe,
    required this.sequence,
    required this.timestamp90k,
    required this.annexB,
  });
}

final class HuddleVideoPeer {
  final int peerIndex;
  final int epoch;
  final String pubkey;
  final List<int> tracks;

  const HuddleVideoPeer({
    required this.peerIndex,
    required this.epoch,
    required this.pubkey,
    required this.tracks,
  });
}

List<HuddleVideoPeer> readVideoPeers(Object? value) {
  if (value is! List) return const [];
  final peers = <HuddleVideoPeer>[];
  for (final entry in value) {
    if (entry is! Map) continue;
    final peerIndex = entry['peer_index'];
    final epoch = entry['epoch'];
    final pubkey = entry['pubkey'];
    final tracks = entry['tracks'];
    if (peerIndex is! int || epoch is! int || pubkey is! String) continue;
    if (tracks is! List) continue;
    peers.add(
      HuddleVideoPeer(
        peerIndex: peerIndex,
        epoch: epoch,
        pubkey: pubkey,
        tracks: [
          for (final track in tracks)
            if (track is Map && track['track'] is int) track['track'] as int,
        ],
      ),
    );
  }
  return peers;
}

final class HuddleVideoWireException implements Exception {
  final String message;
  const HuddleVideoWireException(this.message);
  @override
  String toString() => 'HuddleVideoWireException: $message';
}
