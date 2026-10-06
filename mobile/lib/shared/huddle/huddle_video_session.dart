import 'dart:async';

import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'huddle_auth.dart';
import 'huddle_video_codec.dart';
import 'huddle_video_state.dart';
import 'huddle_video_transport.dart';
import 'huddle_video_wire.dart';

part 'huddle_video_decode.dart';

final huddleVideoCodecProvider = Provider<HuddleVideoCodec>(
  (_) => MethodChannelHuddleVideoCodec(),
);

typedef HuddleVideoTransportFactory =
    HuddleVideoTransport Function(HuddleConnectionParameters parameters);

final huddleVideoTransportFactoryProvider =
    Provider<HuddleVideoTransportFactory>(
      (_) =>
          (parameters) => HuddleVideoTransport(parameters: parameters),
    );

final huddleVideoProvider =
    NotifierProvider<HuddleVideoNotifier, HuddleVideoState>(
      HuddleVideoNotifier.new,
    );

/// Joins the video socket after audio admission and owns camera publish.
final class HuddleVideoNotifier extends Notifier<HuddleVideoState> {
  HuddleVideoTransport? _transport;
  StreamSubscription<HuddleVideoLinkState>? _states;
  StreamSubscription<HuddleVideoFrame>? _frames;
  StreamSubscription<HuddleEncodedCameraFrame>? _encoded;
  StreamSubscription<int>? _keyframes;
  var _generation = 0;
  var _sequence = 0;
  var _published = false;
  var _disposed = false;
  var _cameraBusy = false;
  HuddleVideoCodec? _codec;
  final _textures = <String, int>{};
  final _subscribed = <String>{};

  @override
  HuddleVideoState build() {
    final codec = ref.read(huddleVideoCodecProvider);
    _codec = codec;
    _disposed = false;
    ref.onDispose(() {
      _disposed = true;
      _generation++;
      unawaited(_shutdown(codec));
    });
    return HuddleVideoState.idle;
  }

  Future<void> attach(HuddleConnectionParameters parameters) async {
    final generation = ++_generation;
    final codec = _codec;
    if (codec != null) await _shutdown(codec);
    if (generation != _generation) return;
    final transport = ref.read(huddleVideoTransportFactoryProvider)(parameters);
    _transport = transport;
    _states = transport.states.listen((link) {
      if (generation != _generation) return;
      if (link.phase == HuddleVideoPhase.connected &&
          state.cameraOn &&
          !_published) {
        transport.publishCamera();
        _published = true;
      }
      state = HuddleVideoState(
        cameraOn: state.cameraOn,
        localTextureId: state.localTextureId,
        tiles: _tilesFor(link.peers),
        error: link.error,
        cameraError: state.cameraError,
      );
      _subscribe(link.peers);
    });
    _frames = transport.frames.listen((frame) {
      if (generation != _generation) return;
      unawaited(_decode(frame, generation));
    });
    _keyframes = transport.keyframeLayers.listen((_) {
      if (generation != _generation || _disposed) return;
      unawaited(_codec?.forceKeyframe());
    });
    await transport.connect();
  }

  Future<void> toggleCamera() async {
    if (_cameraBusy) return;
    _cameraBusy = true;
    try {
      if (state.cameraOn) {
        await _stopCamera();
      } else {
        await _startCamera();
      }
    } finally {
      _cameraBusy = false;
    }
  }

  Future<void> _startCamera() async {
    final generation = _generation;
    final codec = _codec;
    if (codec == null) return;
    final int textureId;
    try {
      textureId = await codec.startCamera();
    } on Object catch (error) {
      // A denied permission or busy camera must be visible: the button is
      // the only affordance, and a silent failure reads as "does nothing".
      if (generation == _generation && !_disposed) {
        state = HuddleVideoState(
          tiles: state.tiles,
          error: state.error,
          cameraError: _cameraErrorText(error),
        );
      }
      return;
    }
    if (generation != _generation) {
      await codec.stopCamera();
      return;
    }
    _encoded = codec.encodedFrames.listen((frame) {
      if (generation != _generation) return;
      _transport?.sendFrame(
        HuddleVideoWire.encodeClientFrame(
          track: HuddleVideoWire.trackCamera,
          layer: 0,
          keyframe: frame.keyframe,
          sequence: _sequence++,
          timestamp90k: frame.timestamp90k,
          annexB: frame.annexB,
        ),
      );
    });
    if (_transport?.state.phase == HuddleVideoPhase.connected) {
      _transport?.publishCamera();
      _published = true;
    }
    state = HuddleVideoState(
      cameraOn: true,
      localTextureId: textureId,
      tiles: state.tiles,
      error: state.error,
    );
  }

  Future<void> close() async {
    _generation++;
    final codec = _codec;
    if (codec != null) await _shutdown(codec);
    if (!_disposed) state = HuddleVideoState.idle;
  }

  Future<void> _stopCamera() async {
    await _encoded?.cancel();
    _encoded = null;
    _published = false;
    _transport?.unpublishCamera();
    await _codec?.stopCamera();
    if (_disposed) return;
    state = HuddleVideoState(tiles: state.tiles, error: state.error);
  }

  Future<void> _shutdown(HuddleVideoCodec codec) async {
    await _states?.cancel();
    await _frames?.cancel();
    await _encoded?.cancel();
    await _keyframes?.cancel();
    _states = null;
    _frames = null;
    _encoded = null;
    _keyframes = null;
    await codec.stopCamera();
    for (final textureId in _textures.values) {
      await codec.release(textureId);
    }
    _textures.clear();
    _subscribed.clear();
    _published = false;
    final transport = _transport;
    _transport = null;
    await transport?.dispose();
  }
}

String _cameraErrorText(Object error) => switch (error) {
  PlatformException(:final message?) when message.isNotEmpty => message,
  _ => 'The camera could not start. Try again.',
};
