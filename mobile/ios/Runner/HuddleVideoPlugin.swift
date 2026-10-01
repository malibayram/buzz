import CoreVideo
import Flutter
import Foundation

final class HuddlePixelTexture: NSObject, FlutterTexture {
  var pixelBuffer: CVPixelBuffer?
  func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? {
    guard let pixelBuffer else { return nil }
    return Unmanaged.passRetained(pixelBuffer)
  }
}

/// Camera encode and remote decode for huddle video. Registered beside
/// `buzz/huddle_media`; audio stays on that channel.
final class HuddleVideoPlugin: NSObject, FlutterStreamHandler {
  private let channel: FlutterMethodChannel
  private let capture: HuddleVideoCapture
  private let decode: HuddleVideoDecode
  private var sink: FlutterEventSink?

  init(registrar: FlutterPluginRegistrar) {
    let textures = registrar.textures()
    channel = FlutterMethodChannel(
      name: "buzz/huddle_video",
      binaryMessenger: registrar.messenger()
    )
    capture = HuddleVideoCapture(textures: textures)
    decode = HuddleVideoDecode(textures: textures)
    super.init()
    capture.onEncoded = { [weak self] payload in self?.sink?(payload) }
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
    FlutterEventChannel(
      name: "buzz/huddle_video/frames",
      binaryMessenger: registrar.messenger()
    ).setStreamHandler(self)
  }

  func onListen(
    withArguments arguments: Any?,
    eventSink events: @escaping FlutterEventSink
  ) -> FlutterError? {
    sink = events
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    sink = nil
    return nil
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "startCamera":
      capture.start(result)
    case "stopCamera":
      capture.stop()
      result(nil)
    case "forceKeyframe":
      capture.forceKeyframe()
      result(nil)
    case "decode":
      decode.decode(call.arguments, result: result)
    case "release":
      let args = call.arguments as? [String: Any]
      decode.release((args?["textureId"] as? NSNumber)?.int64Value)
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
