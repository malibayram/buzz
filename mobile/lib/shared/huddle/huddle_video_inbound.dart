part of 'huddle_video_transport.dart';

extension _HuddleVideoInbound on HuddleVideoTransport {
  void _readVideoControl(String raw, int generation) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    switch (decoded['type']) {
      case 'challenge':
        _answerChallenge(decoded, generation);
      case 'tracks':
        _emit(
          HuddleVideoLinkState(
            phase: HuddleVideoPhase.connected,
            peers: readVideoPeers(decoded['peers']),
          ),
        );
      case 'track_delta':
        _replacePeer(decoded);
      case 'keyframe_request':
        final layer = decoded['layer'];
        if (layer is int) _keyframes.add(layer);
      case 'error':
        _readError(decoded, generation);
      default:
        break;
    }
  }

  void _answerChallenge(Map<dynamic, dynamic> message, int generation) {
    final challenge = message['challenge'];
    if (challenge is! String || challenge.isEmpty) {
      _fail(generation, 'auth_failed');
      return;
    }
    _channel?.sink.add(
      jsonEncode(
        HuddleAuthV2.buildMessage(parameters: parameters, challenge: challenge),
      ),
    );
  }

  void _readError(Map<dynamic, dynamic> message, int generation) {
    final code = message['code'];
    final name = code is String ? code : 'error';
    if (name == 'frame_too_large' ||
        name == 'camera_limit' ||
        name == 'screen_share_busy' ||
        name == 'screen_limit') {
      _emit(
        HuddleVideoLinkState(
          phase: _state.phase,
          peers: _state.peers,
          errorCode: name,
          error: HuddleVideoWire.errorText(name),
        ),
      );
      return;
    }
    _fail(generation, name);
  }

  void _replacePeer(Map<dynamic, dynamic> message) {
    final peerIndex = message['peer_index'];
    final epoch = message['epoch'];
    final pubkey = message['pubkey'];
    if (peerIndex is! int || epoch is! int || pubkey is! String) return;
    final parsed = readVideoPeers([
      {
        'peer_index': peerIndex,
        'epoch': epoch,
        'pubkey': pubkey,
        'tracks': message['tracks'],
      },
    ]);
    if (parsed.length != 1) return;
    final tracks = parsed.single.tracks;
    _emit(
      HuddleVideoLinkState(
        phase: HuddleVideoPhase.connected,
        peers: [
          for (final peer in _state.peers)
            if (peer.peerIndex != peerIndex) peer,
          if (tracks.isNotEmpty)
            HuddleVideoPeer(
              peerIndex: peerIndex,
              epoch: epoch,
              pubkey: pubkey,
              tracks: tracks,
            ),
        ],
      ),
    );
  }

  void _readVideoFrame(Uint8List bytes) {
    try {
      _frames.add(HuddleVideoWire.decodeRelayFrame(bytes));
    } on HuddleVideoWireException {
      // A short or oversize frame is dropped. The publisher is told separately.
    }
  }
}
