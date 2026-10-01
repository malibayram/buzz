import AVFoundation
import CoreMedia
import Flutter
import VideoToolbox

final class HuddleVideoCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var onEncoded: (([String: Any]) -> Void)?
  private let textures: FlutterTextureRegistry
  private let preview = HuddlePixelTexture()
  private var previewId: Int64?
  private let session = AVCaptureSession()
  private let queue = DispatchQueue(label: "buzz.huddle.video.capture")
  private var compression: VTCompressionSession?
  private var forceNext = false
  private var timestamp90k: Int32 = 0

  init(textures: FlutterTextureRegistry) {
    self.textures = textures
  }

  func start(_ result: @escaping FlutterResult) {
    AVCaptureDevice.requestAccess(for: .video) { granted in
      DispatchQueue.main.async {
        guard granted else {
          result(FlutterError(code: "permission", message: "Camera permission was denied.", details: nil))
          return
        }
        do { result(try self.open()) } catch {
          result(FlutterError(code: "camera", message: "\(error)", details: nil))
        }
      }
    }
  }

  func stop() {
    session.stopRunning()
    if let compression { VTCompressionSessionInvalidate(compression) }
    compression = nil
    if let previewId { textures.unregisterTexture(previewId) }
    previewId = nil
  }

  func forceKeyframe() { forceNext = true }

  private func open() throws -> Int64 {
    session.beginConfiguration()
    session.sessionPreset = .vga640x480
    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else { throw HuddleVideoCaptureError.unavailable }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ]
    output.setSampleBufferDelegate(self, queue: queue)
    guard session.canAddOutput(output) else { throw HuddleVideoCaptureError.unavailable }
    session.addOutput(output)
    session.commitConfiguration()
    compression = try makeEncoder()
    let textureId = textures.register(preview)
    previewId = textureId
    session.startRunning()
    return textureId
  }

  private func makeEncoder() throws -> VTCompressionSession {
    var encoder: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: 640,
      height: 360,
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
    guard status == noErr, let encoder else { throw HuddleVideoCaptureError.unavailable }
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
    if let previewId { textures.textureFrameAvailable(previewId) }
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

  private func emit(_ sample: CMSampleBuffer) {
    guard let (annex, keyframe) = huddleAnnexB(from: sample) else { return }
    let payload: [String: Any] = [
      "annexB": FlutterStandardTypedData(bytes: annex),
      "keyframe": keyframe,
      "ts90k": timestamp90k,
    ]
    DispatchQueue.main.async { [weak self] in self?.onEncoded?(payload) }
  }
}

private enum HuddleVideoCaptureError: Error { case unavailable }
