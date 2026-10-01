//! Pull Opus packets out of an Ogg Opus blob. Head and tag packets are skipped.

/// Audio packets in `bytes`, in page order.
pub fn opus_packets(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut packets = Vec::new();
    let mut index = 0;
    while let Some((segments, body)) = read_page(bytes, &mut index) {
        let mut packet = Vec::new();
        let mut offset = 0;
        for segment in segments {
            let size = *segment as usize;
            if offset + size > body.len() {
                return packets;
            }
            packet.extend_from_slice(&body[offset..offset + size]);
            offset += size;
            if size < 255 {
                if is_audio(&packet) {
                    packets.push(std::mem::take(&mut packet));
                } else {
                    packet.clear();
                }
            }
        }
    }
    packets
}

fn is_audio(packet: &[u8]) -> bool {
    !packet.is_empty() && !packet.starts_with(b"OpusHead") && !packet.starts_with(b"OpusTags")
}

fn read_page<'a>(bytes: &'a [u8], index: &mut usize) -> Option<(&'a [u8], &'a [u8])> {
    let start = *index;
    if start + 27 > bytes.len() || &bytes[start..start + 4] != b"OggS" {
        return None;
    }
    let count = bytes[start + 26] as usize;
    let table = start + 27;
    if table + count > bytes.len() {
        return None;
    }
    let segments = &bytes[table..table + count];
    let body_len: usize = segments.iter().map(|byte| *byte as usize).sum();
    let body = table + count;
    if body + body_len > bytes.len() {
        return None;
    }
    *index = body + body_len;
    Some((segments, &bytes[body..*index]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(packet: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 28];
        out[..4].copy_from_slice(b"OggS");
        out[26] = 1;
        out[27] = u8::try_from(packet.len()).expect("packet fits one segment");
        out.extend(packet);
        out
    }

    #[test]
    fn skips_headers_and_keeps_audio() {
        let mut bytes = page(b"OpusHead\x01");
        bytes.extend(page(b"OpusTags"));
        bytes.extend(page(&[0x11, 0x22]));
        assert_eq!(opus_packets(&bytes), vec![vec![0x11, 0x22]]);
    }
}
