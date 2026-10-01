//! 12-byte big-endian video access-unit header. Payload is Annex-B H.264.

use bytes::{Bytes, BytesMut};

pub const HEADER_LEN: usize = 12;
pub const FLAG_KEYFRAME: u8 = 0x01;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoFrameHeader {
    pub track: u8,
    pub layer: u8,
    pub flags: u8,
    pub reserved: u8,
    pub frame_seq: u32,
    pub ts_90k: u32,
}

impl VideoFrameHeader {
    pub fn is_keyframe(self) -> bool {
        self.flags & FLAG_KEYFRAME != 0
    }

    /// Parse the header. Reserved bits are preserved. `None` on a short buffer.
    pub fn parse(bytes: &[u8]) -> Option<(Self, &[u8])> {
        if bytes.len() < HEADER_LEN {
            return None;
        }
        Some((
            Self {
                track: bytes[0],
                layer: bytes[1],
                flags: bytes[2],
                reserved: bytes[3],
                frame_seq: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
                ts_90k: u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            },
            &bytes[HEADER_LEN..],
        ))
    }
}

pub enum InboundFrame<'a> {
    Media(&'a [u8]),
    Oversize,
    Malformed,
}

/// Production classifier for one client binary message.
pub fn classify_inbound(bytes: &[u8]) -> InboundFrame<'_> {
    if bytes.len() > super::types::VIDEO_MAX_FRAME_BYTES {
        return InboundFrame::Oversize;
    }
    if VideoFrameHeader::parse(bytes).is_some() {
        InboundFrame::Media(bytes)
    } else {
        InboundFrame::Malformed
    }
}

/// Relay → client prefix: `[peer_index][epoch]` plus the client frame.
pub fn prefix_relay_frame(peer_index: u8, epoch: u8, frame: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(2 + frame.len());
    out.extend_from_slice(&[peer_index, epoch]);
    out.extend_from_slice(frame);
    out.freeze()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_network_byte_order() {
        let mut bytes = vec![
            1,
            0,
            FLAG_KEYFRAME,
            0xAB,
            0x01,
            0x02,
            0x03,
            0x04,
            0x00,
            0x00,
            0x00,
            0x5A,
            0xAA,
        ];
        let (h, payload) = VideoFrameHeader::parse(&bytes).expect("parse");
        assert_eq!(h.track, 1);
        assert_eq!(h.layer, 0);
        assert!(h.is_keyframe());
        assert_eq!(h.reserved, 0xAB);
        assert_eq!(h.frame_seq, 0x0102_0304);
        assert_eq!(h.ts_90k, 0x5A);
        assert_eq!(payload, &[0xAA]);
        bytes[3] = 0x7E;
        assert_eq!(VideoFrameHeader::parse(&bytes).unwrap().0.reserved, 0x7E);
    }

    #[test]
    fn parse_rejects_short_input() {
        for len in 0..HEADER_LEN {
            assert!(VideoFrameHeader::parse(&vec![0; len]).is_none());
        }
    }

    #[test]
    fn classify_drops_oversize_before_a_short_header() {
        assert!(matches!(classify_inbound(&[0; 4]), InboundFrame::Malformed));
        let big = vec![0u8; super::super::types::VIDEO_MAX_FRAME_BYTES + 1];
        assert!(matches!(classify_inbound(&big), InboundFrame::Oversize));
    }
}
