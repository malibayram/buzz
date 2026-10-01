//! v4 huddle audio frames. Opus bytes stay opaque.

/// Eight-byte client header shared with desktop and mobile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioHeader {
    /// Wrapping sequence number.
    pub sequence: u16,
    /// Sender timestamp at 48 kHz.
    pub timestamp_48k: u32,
    /// Sender level in dBov, from -127 through 0.
    pub level_dbov: i8,
    /// Bit 0 marks Opus DTX.
    pub flags: u8,
}

/// One relay-to-client audio frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAudio {
    /// Occupant index.
    pub peer_index: u8,
    /// Occupancy epoch for [`Self::peer_index`].
    pub epoch: u8,
    /// Parsed header.
    pub header: AudioHeader,
    /// Opaque Opus payload.
    pub opus: Vec<u8>,
}

/// A frame that is too short or too large to be audio.
#[derive(Debug, PartialEq, Eq)]
pub struct FrameError;

const HEADER_LEN: usize = 8;
const MAX_FRAME: usize = 4096;

/// Encode `header | opus` for the client-to-relay direction.
pub fn encode_client_frame(header: AudioHeader, opus: &[u8]) -> Result<Vec<u8>, FrameError> {
    if opus.is_empty() || HEADER_LEN + opus.len() > MAX_FRAME {
        return Err(FrameError);
    }
    let mut out = Vec::with_capacity(HEADER_LEN + opus.len());
    out.extend_from_slice(&header.sequence.to_be_bytes());
    out.extend_from_slice(&header.timestamp_48k.to_be_bytes());
    out.push(header.level_dbov as u8);
    out.push(header.flags);
    out.extend_from_slice(opus);
    Ok(out)
}

/// Decode `peer_index | epoch | header | opus`.
pub fn decode_relay_frame(bytes: &[u8]) -> Result<RemoteAudio, FrameError> {
    if bytes.len() < 2 + HEADER_LEN + 1 || bytes.len() > MAX_FRAME + 2 {
        return Err(FrameError);
    }
    let header = AudioHeader {
        sequence: u16::from_be_bytes([bytes[2], bytes[3]]),
        timestamp_48k: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        level_dbov: bytes[8] as i8,
        flags: bytes[9],
    };
    Ok(RemoteAudio {
        peer_index: bytes[0],
        epoch: bytes[1],
        header,
        opus: bytes[10..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_frame_matches_the_shared_golden_bytes() {
        let frame = encode_client_frame(
            AudioHeader {
                sequence: 0x1234,
                timestamp_48k: 0x0102_0304,
                level_dbov: -42,
                flags: 0x01,
            },
            &[0xaa, 0xbb],
        )
        .expect("frame");
        assert_eq!(
            frame,
            [0x12, 0x34, 0x01, 0x02, 0x03, 0x04, 0xd6, 0x01, 0xaa, 0xbb]
        );
    }

    #[test]
    fn relay_frame_carries_the_occupancy_epoch() {
        let mut bytes = vec![0x07, 0x09];
        bytes.extend(
            encode_client_frame(
                AudioHeader {
                    sequence: 0x1234,
                    timestamp_48k: 0x0102_0304,
                    level_dbov: -42,
                    flags: 0x01,
                },
                &[0xaa, 0xbb],
            )
            .expect("frame"),
        );
        let frame = decode_relay_frame(&bytes).expect("decode");
        assert_eq!(frame.peer_index, 7);
        assert_eq!(frame.epoch, 9);
        assert_eq!(frame.opus, [0xaa, 0xbb]);
    }

    #[test]
    fn short_input_is_rejected() {
        assert_eq!(decode_relay_frame(&[1, 2, 3]), Err(FrameError));
    }
}
