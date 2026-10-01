import 'dart:typed_data';

import 'package:buzz/shared/huddle/huddle_video_wire.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('round-trips a keyframe and reads the relay epoch prefix', () {
    final encoded = HuddleVideoWire.encodeClientFrame(
      track: HuddleVideoWire.trackCamera,
      layer: 0,
      keyframe: true,
      sequence: 0x01020304,
      timestamp90k: 0x05060708,
      annexB: Uint8List.fromList([0, 0, 0, 1, 0x65]),
    );
    final relay = Uint8List(2 + encoded.length)
      ..[0] = 4
      ..[1] = 9
      ..setRange(2, 2 + encoded.length, encoded);

    final frame = HuddleVideoWire.decodeRelayFrame(relay);

    expect(frame.peerIndex, 4);
    expect(frame.epoch, 9);
    expect(frame.track, 0);
    expect(frame.keyframe, isTrue);
    expect(frame.sequence, 0x01020304);
    expect(frame.timestamp90k, 0x05060708);
    expect(frame.annexB, [0, 0, 0, 1, 0x65]);
  });

  test('rejects a short relay frame', () {
    expect(
      () => HuddleVideoWire.decodeRelayFrame(Uint8List(8)),
      throwsA(isA<HuddleVideoWireException>()),
    );
  });

  test('reads a track snapshot and names a busy screen', () {
    final peers = readVideoPeers([
      {
        'peer_index': 2,
        'epoch': 1,
        'pubkey': 'abc',
        'tracks': [
          {'track': 1, 'codec': HuddleVideoWire.codec},
        ],
      },
    ]);

    expect(peers.single.tracks, [1]);
    expect(
      HuddleVideoWire.errorText('screen_share_busy'),
      'Someone else is sharing their screen',
    );
  });
}
