part of 'huddle_video_session.dart';

extension _HuddleVideoDecode on HuddleVideoNotifier {
  List<HuddleVideoTile> _tilesFor(List<HuddleVideoPeer> peers) {
    final tiles = <HuddleVideoTile>[];
    for (final peer in peers) {
      for (final track in peer.tracks) {
        final key = '${peer.peerIndex}:${peer.epoch}:$track';
        tiles.add(
          HuddleVideoTile(
            peerIndex: peer.peerIndex,
            epoch: peer.epoch,
            track: track,
            pubkey: peer.pubkey,
            textureId: _textures[key],
          ),
        );
      }
    }
    return tiles;
  }

  void _subscribe(List<HuddleVideoPeer> peers) {
    for (final peer in peers) {
      for (final track in peer.tracks) {
        final key = '${peer.peerIndex}:${peer.epoch}:$track';
        if (!_subscribed.add(key)) continue;
        _transport?.subscribe(
          peerIndex: peer.peerIndex,
          epoch: peer.epoch,
          track: track,
          layer: 0,
        );
      }
    }
  }

  Future<void> _decode(HuddleVideoFrame frame, int generation) async {
    final key = '${frame.peerIndex}:${frame.epoch}:${frame.track}';
    final codec = _codec;
    if (codec == null || generation != _generation) return;
    final textureId = await codec.decode(
      peerIndex: frame.peerIndex,
      epoch: frame.epoch,
      track: frame.track,
      annexB: frame.annexB,
      keyframe: frame.keyframe,
    );
    if (_disposed || generation != _generation) {
      await codec.release(textureId);
      return;
    }
    _textures[key] = textureId;
    state = HuddleVideoState(
      cameraOn: state.cameraOn,
      localTextureId: state.localTextureId,
      tiles: [
        for (final tile in state.tiles)
          if (tile.key == key)
            HuddleVideoTile(
              peerIndex: tile.peerIndex,
              epoch: tile.epoch,
              track: tile.track,
              pubkey: tile.pubkey,
              textureId: textureId,
            )
          else
            tile,
      ],
      error: state.error,
    );
  }
}
