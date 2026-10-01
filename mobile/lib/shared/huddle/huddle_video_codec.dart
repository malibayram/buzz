import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/services.dart';

/// One encoded camera access unit from the native 360p encoder.
final class HuddleEncodedCameraFrame {
  final Uint8List annexB;
  final bool keyframe;
  final int timestamp90k;

  const HuddleEncodedCameraFrame({
    required this.annexB,
    required this.keyframe,
    required this.timestamp90k,
  });
}

/// Native camera encoder and remote H.264 decoder. Textures stay on the
/// platform side; Dart only sees ids and Annex-B access units.
abstract class HuddleVideoCodec {
  Stream<HuddleEncodedCameraFrame> get encodedFrames;
  Future<int> startCamera();
  Future<void> stopCamera();
  Future<void> forceKeyframe();
  Future<int> decode({
    required int peerIndex,
    required int epoch,
    required int track,
    required Uint8List annexB,
    required bool keyframe,
  });
  Future<void> release(int textureId);
}

final class MethodChannelHuddleVideoCodec implements HuddleVideoCodec {
  MethodChannelHuddleVideoCodec({MethodChannel? channel, EventChannel? frames})
    : _channel = channel ?? const MethodChannel('buzz/huddle_video'),
      _frames = frames ?? const EventChannel('buzz/huddle_video/frames');

  final MethodChannel _channel;
  final EventChannel _frames;

  @override
  Stream<HuddleEncodedCameraFrame> get encodedFrames =>
      _frames.receiveBroadcastStream().map((event) {
        final map = Map<Object?, Object?>.from(event as Map);
        final bytes = map['annexB'];
        final timestamp = map['ts90k'];
        if (bytes is! Uint8List || timestamp is! int) {
          throw const FormatException('Encoded camera frame was malformed.');
        }
        return HuddleEncodedCameraFrame(
          annexB: bytes,
          keyframe: map['keyframe'] == true,
          timestamp90k: timestamp,
        );
      });

  @override
  Future<int> startCamera() async =>
      (await _channel.invokeMethod<int>('startCamera')) ??
      (throw StateError('Camera did not return a texture.'));

  @override
  Future<void> stopCamera() => _channel.invokeMethod<void>('stopCamera');

  @override
  Future<void> forceKeyframe() => _channel.invokeMethod<void>('forceKeyframe');

  @override
  Future<int> decode({
    required int peerIndex,
    required int epoch,
    required int track,
    required Uint8List annexB,
    required bool keyframe,
  }) async =>
      (await _channel.invokeMethod<int>('decode', {
        'peer': peerIndex,
        'epoch': epoch,
        'track': track,
        'annexB': annexB,
        'keyframe': keyframe,
      })) ??
      (throw StateError('Decoder did not return a texture.'));

  @override
  Future<void> release(int textureId) =>
      _channel.invokeMethod<void>('release', {'textureId': textureId});
}
