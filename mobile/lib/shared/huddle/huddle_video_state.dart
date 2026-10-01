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
  final String? error;

  const HuddleVideoState({
    this.cameraOn = false,
    this.localTextureId,
    this.tiles = const [],
    this.error,
  });

  static const idle = HuddleVideoState();
}
