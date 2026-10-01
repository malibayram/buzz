import CoreMedia
import Flutter
import VideoToolbox

final class HuddleVideoDecode {
  private let textures: FlutterTextureRegistry
  private var slots: [String: Slot] = [:]

  init(textures: FlutterTextureRegistry) { self.textures = textures }

  func decode(_ arguments: Any?, result: @escaping FlutterResult) {
    guard
      let args = arguments as? [String: Any],
      let peer = args["peer"] as? Int,
      let epoch = args["epoch"] as? Int,
      let track = args["track"] as? Int,
      let annex = (args["annexB"] as? FlutterStandardTypedData)?.data
    else {
      result(FlutterError(code: "decode", message: "Video frame was malformed.", details: nil))
      return
    }
    let key = "\(peer):\(epoch):\(track)"
    let slot = slots[key] ?? Slot(textures: textures)
    slots[key] = slot
    if let sample = huddleSampleBuffer(from: annex),
      slot.prepare(CMSampleBufferGetFormatDescription(sample)),
      let session = slot.session
    {
      VTDecompressionSessionDecodeFrame(
        session,
        sampleBuffer: sample,
        flags: [],
        frameRefcon: nil,
        infoFlagsOut: nil
      )
    }
    result(slot.textureId)
  }

  func release(_ textureId: Int64?) {
    guard let textureId else { return }
    slots = slots.filter { _, slot in
      guard slot.textureId == textureId else { return true }
      slot.invalidate()
      textures.unregisterTexture(textureId)
      return false
    }
  }
}

private final class Slot {
  let texture = HuddlePixelTexture()
  let textureId: Int64
  private let textures: FlutterTextureRegistry
  var session: VTDecompressionSession?
  private var format: CMFormatDescription?

  init(textures: FlutterTextureRegistry) {
    self.textures = textures
    textureId = textures.register(texture)
  }

  func prepare(_ next: CMFormatDescription?) -> Bool {
    guard let next else { return session != nil }
    if let format, CMFormatDescriptionEqual(format, otherFormatDescription: next) {
      return session != nil
    }
    invalidate()
    var created: VTDecompressionSession?
    var callback = VTDecompressionOutputCallbackRecord(
      decompressionOutputCallback: { refcon, _, status, _, image, _, _ in
        guard status == noErr, let image, let refcon else { return }
        let slot = Unmanaged<Slot>.fromOpaque(refcon).takeUnretainedValue()
        slot.texture.pixelBuffer = image
        slot.textures.textureFrameAvailable(slot.textureId)
      },
      decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
    )
    guard
      VTDecompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        formatDescription: next,
        decoderSpecification: nil,
        imageBufferAttributes: nil,
        outputCallback: &callback,
        decompressionSessionOut: &created
      ) == noErr
    else { return false }
    format = next
    session = created
    return true
  }

  func invalidate() {
    if let session { VTDecompressionSessionInvalidate(session) }
    session = nil
  }
}
