import AVFoundation
import CoreMedia
import Flutter
import VideoToolbox

/// Front-camera capture for huddle video: a preview texture plus H.264
/// (Annex B) frames for the relay.
///
/// The capture session is configured once and reused, so turning the camera
/// off and on again (or joining a later huddle) works. AVFoundation start/stop
/// blocks, so it runs on `sessionQueue`; frames and the encoder belong to
/// `queue`. Frames are portrait 360×640; receivers size from the H.264 stream.
final class HuddleVideoCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  static let width: Int32 = 360
  static let height: Int32 = 640

  var onEncoded: (([String: Any]) -> Void)?
  private let textures: FlutterTextureRegistry
  private let preview = HuddlePixelTexture()
  /// Registered preview texture; owned by the main thread.
  private var previewId: Int64?
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "buzz.huddle.video.session")
  private let queue = DispatchQueue(label: "buzz.huddle.video.capture")
  /// Whether inputs/outputs are attached; owned by `sessionQueue`.
  private var configured = false
  // Owned by `queue`.
  private var compression: VTCompressionSession?
  private var framePreviewId: Int64?
  private var forceNext = false
  private var timestamp90k: Int32 = 0

  init(textures: FlutterTextureRegistry) {
    self.textures = textures
  }

  func start(_ result: @escaping FlutterResult) {
    AVCaptureDevice.requestAccess(for: .video) { granted in
      guard granted else {
        DispatchQueue.main.async {
          result(FlutterError(
            code: "permission",
            message: "Camera access is off for Buzz. Turn it on in Settings › Buzz › Camera.",
            details: nil
          ))
        }
        return
      }
      self.sessionQueue.async { self.open(result) }
    }
  }

  func stop() {
    if let previewId { textures.unregisterTexture(previewId) }
    previewId = nil
    sessionQueue.async {
      if self.session.isRunning { self.session.stopRunning() }
      self.queue.sync {
        if let compression = self.compression { VTCompressionSessionInvalidate(compression) }
        self.compression = nil
        self.framePreviewId = nil
        self.preview.pixelBuffer = nil
      }
    }
  }

  func forceKeyframe() { queue.async { self.forceNext = true } }

  /// Runs on `sessionQueue`; always answers `result` on the main thread.
  private func open(_ result: @escaping FlutterResult) {
    do {
      try configureOnce()
      let encoder = try makeEncoder()
      queue.sync {
        if let old = compression { VTCompressionSessionInvalidate(old) }
        compression = encoder
        forceNext = true
      }
      if !session.isRunning { session.startRunning() }
      DispatchQueue.main.async {
        let textureId = self.previewId ?? self.textures.register(self.preview)
        self.previewId = textureId
        self.queue.async { self.framePreviewId = textureId }
        result(textureId)
      }
    } catch {
      let message = (error as? HuddleVideoCaptureError)?.message ?? "\(error)"
      DispatchQueue.main.async {
        result(FlutterError(code: "camera", message: message, details: nil))
      }
    }
  }

  private func configureOnce() throws {
    if configured { return }
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = session.canSetSessionPreset(.hd1280x720) ? .hd1280x720 : .vga640x480
    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        ?? AVCaptureDevice.default(for: .video)
    else { throw HuddleVideoCaptureError.noCamera }
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { throw HuddleVideoCaptureError.busy }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ]
    output.setSampleBufferDelegate(self, queue: queue)
    guard session.canAddOutput(output) else {
      session.removeInput(input)
      throw HuddleVideoCaptureError.busy
    }
    session.addOutput(output)
    if let connection = output.connection(with: .video) {
      if #available(iOS 17.0, *) {
        if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
      } else if connection.isVideoOrientationSupported {
        connection.videoOrientation = .portrait
      }
    }
    configured = true
  }

  private func makeEncoder() throws -> VTCompressionSession {
    var encoder: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Self.width,
      height: Self.height,
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: { refcon, _, status, _, sample in
        guard status == noErr, let sample, let refcon else { return }
        Unmanaged<HuddleVideoCapture>.fromOpaque(refcon).takeUnretainedValue().emit(sample)
      },
      refcon: Unmanaged.passUnretained(self).toOpaque(),
      compressionSessionOut: &encoder
    )
    guard status == noErr, let encoder else { throw HuddleVideoCaptureError.encoder }
    VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AverageBitRate, value: 600_000 as CFNumber)
    VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 24 as CFNumber)
    VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTCompressionSessionPrepareToEncodeFrames(encoder)
    return encoder
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let pixel = CMSampleBufferGetImageBuffer(sampleBuffer), let compression else { return }
    preview.pixelBuffer = pixel
    if let framePreviewId { textures.textureFrameAvailable(framePreviewId) }
    timestamp90k &+= 3750
    var flags = VTEncodeInfoFlags()
    let properties: CFDictionary? = forceNext
      ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
      : nil
    forceNext = false
    VTCompressionSessionEncodeFrame(
      compression,
      imageBuffer: pixel,
      presentationTimeStamp: CMTime(value: CMTimeValue(timestamp90k), timescale: 90_000),
      duration: .invalid,
      frameProperties: properties,
      sourceFrameRefcon: nil,
      infoFlagsOut: &flags
    )
  }

  /// Runs on the encoder's callback thread; the timestamp comes from the
  /// frame itself rather than the capture queue's counter.
  private func emit(_ sample: CMSampleBuffer) {
    guard let (annex, keyframe) = huddleAnnexB(from: sample) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).convertScale(90_000, method: .default)
    let payload: [String: Any] = [
      "annexB": FlutterStandardTypedData(bytes: annex),
      "keyframe": keyframe,
      "ts90k": Int32(truncatingIfNeeded: pts.value),
    ]
    DispatchQueue.main.async { [weak self] in self?.onEncoded?(payload) }
  }
}

private enum HuddleVideoCaptureError: Error {
  case noCamera
  case busy
  case encoder

  var message: String {
    switch self {
    case .noCamera: return "This device has no camera Buzz can use."
    case .busy: return "The camera is in use by another app. Close it and try again."
    case .encoder: return "The camera could not start video encoding."
    }
  }
}
