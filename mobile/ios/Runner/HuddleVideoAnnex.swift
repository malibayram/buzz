import CoreMedia
import Foundation

func huddleAnnexB(from sample: CMSampleBuffer) -> (Data, Bool)? {
  guard let buffer = CMSampleBufferGetDataBuffer(sample) else { return nil }
  var length = 0
  var pointer: UnsafeMutablePointer<Int8>?
  guard
    CMBlockBufferGetDataPointer(
      buffer,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == kCMBlockBufferNoErr,
    let pointer
  else { return nil }
  let avcc = Data(bytes: pointer, count: length)
  var annex = Data()
  let keyframe = huddleIsKeyframe(sample)
  if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
    huddleAppendParameterSets(format, to: &annex)
  }
  var offset = 0
  while offset + 4 <= avcc.count {
    let nalLength = avcc.subdata(in: offset..<(offset + 4)).withUnsafeBytes {
      Int($0.load(as: UInt32.self).bigEndian)
    }
    offset += 4
    guard nalLength > 0, offset + nalLength <= avcc.count else { return nil }
    annex.append(contentsOf: [0, 0, 0, 1])
    annex.append(avcc.subdata(in: offset..<(offset + nalLength)))
    offset += nalLength
  }
  return annex.isEmpty ? nil : (annex, keyframe)
}

func huddleSampleBuffer(from annexB: Data) -> CMSampleBuffer? {
  let nals = huddleSplitAnnexB(annexB)
  let sets = nals.filter { huddleNalType($0) == 7 || huddleNalType($0) == 8 }
  let slices = nals.filter { huddleNalType($0) == 1 || huddleNalType($0) == 5 }
  guard !sets.isEmpty, !slices.isEmpty else { return nil }
  let sps = sets.first { huddleNalType($0) == 7 }
  let pps = sets.first { huddleNalType($0) == 8 }
  guard let sps, let pps else { return nil }
  var format: CMFormatDescription?
  let created: OSStatus = sps.withUnsafeBytes { spsBytes in
    pps.withUnsafeBytes { ppsBytes in
      let pointers = [
        spsBytes.bindMemory(to: UInt8.self).baseAddress,
        ppsBytes.bindMemory(to: UInt8.self).baseAddress,
      ]
      var sizes = [sps.count, pps.count]
      return pointers.withUnsafeBufferPointer { buffer in
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: 2,
          parameterSetPointers: buffer.baseAddress!,
          parameterSetSizes: &sizes,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &format
        )
      }
    }
  }
  guard created == noErr, let format else { return nil }
  var avcc = Data()
  for slice in slices {
    var length = UInt32(slice.count).bigEndian
    avcc.append(Data(bytes: &length, count: 4))
    avcc.append(slice)
  }
  var block: CMBlockBuffer?
  guard
    CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: avcc.count,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: avcc.count,
      flags: 0,
      blockBufferOut: &block
    ) == kCMBlockBufferNoErr,
    let block,
    CMBlockBufferReplaceDataBytes(
      with: (avcc as NSData).bytes,
      blockBuffer: block,
      offsetIntoDestination: 0,
      dataLength: avcc.count
    ) == kCMBlockBufferNoErr
  else { return nil }
  var sample: CMSampleBuffer?
  var timing = CMSampleTimingInfo(
    duration: .invalid,
    presentationTimeStamp: .zero,
    decodeTimeStamp: .invalid
  )
  guard
    CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: block,
      formatDescription: format,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 0,
      sampleSizeArray: nil,
      sampleBufferOut: &sample
    ) == noErr
  else { return nil }
  return sample
}

private func huddleIsKeyframe(_ sample: CMSampleBuffer) -> Bool {
  guard
    let attachments = CMSampleBufferGetSampleAttachmentsArray(
      sample,
      createIfNecessary: false
    ) as? [[CFString: Any]],
    let notSync = attachments.first?[kCMSampleAttachmentKey_NotSync] as? Bool
  else { return true }
  return !notSync
}

private func huddleAppendParameterSets(
  _ format: CMFormatDescription,
  to annex: inout Data
) {
  var count = 0
  CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
    format,
    parameterSetIndex: 0,
    parameterSetPointerOut: nil,
    parameterSetSizeOut: nil,
    parameterSetCountOut: &count,
    nalUnitHeaderLengthOut: nil
  )
  for index in 0..<count {
    var pointer: UnsafePointer<UInt8>?
    var size = 0
    guard
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil
      ) == noErr,
      let pointer
    else { continue }
    annex.append(contentsOf: [0, 0, 0, 1])
    annex.append(pointer, count: size)
  }
}

private func huddleSplitAnnexB(_ data: Data) -> [Data] {
  var units: [Data] = []
  var start: Int?
  var index = 0
  while index + 3 < data.count {
    let long = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 0
      && index + 3 < data.count && data[index + 3] == 1
    let short = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1
    if long || short {
      if let start { units.append(data.subdata(in: start..<index)) }
      index += long ? 4 : 3
      start = index
    } else {
      index += 1
    }
  }
  if let start, start < data.count { units.append(data.subdata(in: start..<data.count)) }
  return units.filter { !$0.isEmpty }
}

private func huddleNalType(_ nal: Data) -> UInt8 {
  nal.isEmpty ? 0 : nal[0] & 0x1f
}
