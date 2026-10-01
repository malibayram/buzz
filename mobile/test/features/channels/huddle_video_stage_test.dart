import 'dart:async';
import 'dart:typed_data';

import 'package:buzz/features/channels/huddle_video_stage.dart';
import 'package:buzz/shared/huddle/huddle.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  testWidgets('camera toggle starts the codec and a remote tile is named', (
    tester,
  ) async {
    final codec = _FakeCodec();
    final socket = _StageSocket();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          huddleVideoCodecProvider.overrideWithValue(codec),
          huddleVideoTransportFactoryProvider.overrideWith(
            (ref) =>
                (parameters) => HuddleVideoTransport(
                  parameters: parameters,
                  socketFactory: (_) => socket,
                ),
          ),
        ],
        child: const MaterialApp(home: Scaffold(body: HuddleVideoStage())),
      ),
    );

    final context = tester.element(find.byType(HuddleVideoStage));
    final container = ProviderScope.containerOf(context);
    unawaited(
      container
          .read(huddleVideoProvider.notifier)
          .attach(
            HuddleConnectionParameters(
              relayWebSocketUrl: 'wss://buzz.example',
              nsec: '09b3065e3570a3a4054660dccd66e12774a99a904fdb0ca02dbc6c3136249506',
              parentChannelId: '11111111-2222-4333-8444-555555555555',
              ephemeralChannelId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            ),
          ),
    );
    await tester.pump();
    socket.add('{"type":"challenge","challenge":"abc"}');
    await tester.pump();
    socket.add(
      '{"type":"tracks","peers":[{"peer_index":1,"epoch":0,"pubkey":"ada","tracks":[{"track":0}]}]}',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('huddle-camera-toggle')));
    await tester.pump();

    expect(codec.starts, 1);
    expect(find.byTooltip('Turn camera off'), findsOneWidget);
  });
}

final class _FakeCodec implements HuddleVideoCodec {
  var starts = 0;
  final _frames = StreamController<HuddleEncodedCameraFrame>.broadcast();

  @override
  Stream<HuddleEncodedCameraFrame> get encodedFrames => _frames.stream;

  @override
  Future<int> startCamera() async {
    starts += 1;
    return 7;
  }

  @override
  Future<void> stopCamera() async {}

  @override
  Future<void> forceKeyframe() async {}

  @override
  Future<int> decode({
    required int peerIndex,
    required int epoch,
    required int track,
    required Uint8List annexB,
    required bool keyframe,
  }) async => 3;

  @override
  Future<void> release(int textureId) async {}
}

final class _StageSocket implements WebSocketChannel {
  final _stream = StreamController<dynamic>();
  void add(String value) => _stream.add(value);

  @override
  Future<void> get ready => Future<void>.value();

  @override
  Stream<dynamic> get stream => _stream.stream;

  @override
  WebSocketSink get sink => _StageSink();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _StageSink implements WebSocketSink {
  @override
  void add(dynamic event) {}

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<dynamic> stream) async {}

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}

  @override
  Future<void> get done => Future<void>.value();
}
