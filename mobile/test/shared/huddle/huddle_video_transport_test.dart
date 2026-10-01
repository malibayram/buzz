import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/shared/huddle/huddle_auth.dart';
import 'package:buzz/shared/huddle/huddle_video_transport.dart';
import 'package:buzz/shared/huddle/huddle_video_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

const _privateKey =
    '09b3065e3570a3a4054660dccd66e12774a99a904fdb0ca02dbc6c3136249506';

void main() {
  test('authenticates, applies a track, then drops it', () async {
    final socket = _FakeSocket();
    final transport = HuddleVideoTransport(
      parameters: HuddleConnectionParameters(
        relayWebSocketUrl: 'wss://buzz.example',
        nsec: _privateKey,
        parentChannelId: '11111111-2222-4333-8444-555555555555',
        ephemeralChannelId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      ),
      socketFactory: (_) => socket,
    );
    addTearDown(transport.dispose);

    final connect = transport.connect();
    socket.emit('{"type":"challenge","challenge":"abc"}');
    await Future<void>.delayed(Duration.zero);
    final auth = jsonDecode(socket.sent.whereType<String>().single);
    expect(auth['protocol_version'], 4);

    socket.emit(
      jsonEncode({
        'type': 'tracks',
        'revision': 1,
        'peers': [
          {
            'peer_index': 4,
            'epoch': 2,
            'pubkey': 'remote',
            'tracks': [
              {'track': 0},
            ],
          },
        ],
      }),
    );
    await connect;
    expect(transport.state.peers.single.epoch, 2);

    final frame = HuddleVideoWire.encodeClientFrame(
      track: 0,
      layer: 0,
      keyframe: true,
      sequence: 1,
      timestamp90k: 90,
      annexB: Uint8List.fromList([1]),
    );
    final received = transport.frames.first;
    socket.emit(
      Uint8List(2 + frame.length)
        ..[0] = 4
        ..[1] = 2
        ..setRange(2, 2 + frame.length, frame),
    );
    expect((await received).peerIndex, 4);

    socket.emit(
      jsonEncode({
        'type': 'track_delta',
        'peer_index': 4,
        'epoch': 2,
        'pubkey': 'remote',
        'tracks': <Object>[],
      }),
    );
    await Future<void>.delayed(Duration.zero);
    expect(transport.state.peers, isEmpty);

    socket.emit('{"type":"error","code":"screen_share_busy"}');
    await Future<void>.delayed(Duration.zero);
    expect(transport.state.phase, HuddleVideoPhase.connected);
    expect(transport.state.errorCode, 'screen_share_busy');
  });
}

final class _FakeSocket implements WebSocketChannel {
  final _stream = StreamController<dynamic>();
  final sent = <dynamic>[];

  void emit(Object value) => _stream.add(value);

  @override
  Future<void> get ready => Future<void>.value();

  @override
  Stream<dynamic> get stream => _stream.stream;

  @override
  WebSocketSink get sink => _Sink(sent);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _Sink implements WebSocketSink {
  _Sink(this.sent);
  final List<dynamic> sent;

  @override
  void add(dynamic event) => sent.add(event);

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<dynamic> stream) async {}

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}

  @override
  Future<void> get done => Future<void>.value();
}
