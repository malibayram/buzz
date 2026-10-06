final class HuddleVideoTile {
  final int peerIndex;
  final int epoch;
  final int track;
  final String pubkey;
  final int? textureId;

  const HuddleVideoTile({
    required this.peerIndex,
    required this.epoch,
    required this.track,
    required this.pubkey,
    this.textureId,
  });

  String get key => '$peerIndex:$epoch:$track';
}

final class HuddleVideoState {
  final bool cameraOn;
  final int? localTextureId;
  final List<HuddleVideoTile> tiles;

  /// The video link's error; replaced on every link update.
  final String? error;

  /// Why the camera failed to start; kept until the next camera attempt.
  final String? cameraError;

  const HuddleVideoState({
    this.cameraOn = false,
    this.localTextureId,
    this.tiles = const [],
    this.error,
    this.cameraError,
  });

  static const idle = HuddleVideoState();
}
