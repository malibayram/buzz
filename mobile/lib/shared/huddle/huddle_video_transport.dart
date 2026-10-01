import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'huddle_auth.dart';
import 'huddle_video_wire.dart';

part 'huddle_video_inbound.dart';

typedef HuddleVideoSocketFactory = WebSocketChannel Function(Uri uri);

WebSocketChannel _openVideoSocket(Uri uri) =>
    IOWebSocketChannel.connect(uri, pingInterval: const Duration(seconds: 30));

enum HuddleVideoPhase { idle, connecting, connected, failed, closed }

final class HuddleVideoLinkState {
  final HuddleVideoPhase phase;
  final List<HuddleVideoPeer> peers;
  final String? error;
  final String? errorCode;

  const HuddleVideoLinkState({
    required this.phase,
    this.peers = const [],
    this.error,
    this.errorCode,
  });

  static const idle = HuddleVideoLinkState(phase: HuddleVideoPhase.idle);
}

/// Video socket bound to an already-admitted audio peer. One generation owns
/// the socket; a later connect or close ignores the previous handler.
final class HuddleVideoTransport {
  HuddleVideoTransport({
    required this.parameters,
    HuddleVideoSocketFactory? socketFactory,
  }) : _socketFactory = socketFactory ?? _openVideoSocket;

  final HuddleConnectionParameters parameters;
  final HuddleVideoSocketFactory _socketFactory;
  final _states = StreamController<HuddleVideoLinkState>.broadcast();
  final _frames = StreamController<HuddleVideoFrame>.broadcast();
  final _keyframes = StreamController<int>.broadcast();

  HuddleVideoLinkState _state = HuddleVideoLinkState.idle;
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  var _generation = 0;
  var _closed = false;

  HuddleVideoLinkState get state => _state;
  Stream<HuddleVideoLinkState> get states => _states.stream;
  Stream<HuddleVideoFrame> get frames => _frames.stream;
  Stream<int> get keyframeLayers => _keyframes.stream;

  Future<void> connect() async {
    if (_closed) return;
    final generation = ++_generation;
    await _dropSocket();
    _emit(const HuddleVideoLinkState(phase: HuddleVideoPhase.connecting));
    try {
      final channel = _socketFactory(parameters.videoWebSocketUri);
      _channel = channel;
      await channel.ready;
      if (generation != _generation) return;
      _subscription = channel.stream.listen(
        (raw) => _onMessage(raw, generation),
        onError: (Object _) => _fail(generation, 'connection_failed'),
        onDone: () {
          if (generation == _generation && !_closed) {
            _emit(const HuddleVideoLinkState(phase: HuddleVideoPhase.closed));
          }
        },
      );
    } catch (error) {
      _fail(generation, 'connection_failed', '$error');
    }
  }

  void publishCamera() => _sendJson(HuddleVideoWire.cameraPublish());

  void unpublishCamera() =>
      _sendJson({'type': 'unpublish', 'track': HuddleVideoWire.trackCamera});

  void subscribe({
    required int peerIndex,
    required int epoch,
    required int track,
    required int? layer,
  }) => _sendJson(
    HuddleVideoWire.subscribe(
      peerIndex: peerIndex,
      epoch: epoch,
      track: track,
      layer: layer,
    ),
  );

  void sendFrame(Uint8List frame) {
    if (_state.phase != HuddleVideoPhase.connected) return;
    _channel?.sink.add(frame);
  }

  Future<void> close() async {
    _generation++;
    _closed = true;
    await _dropSocket();
    _emit(const HuddleVideoLinkState(phase: HuddleVideoPhase.closed));
  }

  Future<void> dispose() async {
    await close();
    await _states.close();
    await _frames.close();
    await _keyframes.close();
  }

  void _onMessage(dynamic raw, int generation) {
    if (generation != _generation) return;
    if (raw is String) {
      _onText(raw, generation);
    } else if (raw is List<int>) {
      _onBinary(Uint8List.fromList(raw));
    }
  }

  void _onText(String raw, int generation) =>
      _readVideoControl(raw, generation);

  void _onBinary(Uint8List bytes) => _readVideoFrame(bytes);

  void _sendJson(Map<String, Object?> message) {
    if (_state.phase != HuddleVideoPhase.connected) return;
    _channel?.sink.add(jsonEncode(message));
  }

  void _fail(int generation, String code, [String? message]) {
    if (generation != _generation) return;
    _emit(
      HuddleVideoLinkState(
        phase: HuddleVideoPhase.failed,
        errorCode: code,
        error: message ?? HuddleVideoWire.errorText(code),
      ),
    );
  }

  void _emit(HuddleVideoLinkState next) {
    _state = next;
    if (!_states.isClosed) _states.add(next);
  }

  Future<void> _dropSocket() async {
    await _subscription?.cancel();
    _subscription = null;
    await _channel?.sink.close();
    _channel = null;
  }
}
