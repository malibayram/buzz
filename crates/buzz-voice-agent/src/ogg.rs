//! Wrap raw Opus packets in an Ogg Opus file the STT endpoint can decode.

pub fn ogg_opus(packets: &[Vec<u8>]) -> Vec<u8> {
    let serial = 0x4255_5a5a;
    let head = opus_head();
    let tags = opus_tags();
    let mut out = Vec::new();
    out.extend(page(0x02, 0, serial, 0, &[&head]));
    out.extend(page(0x00, 0, serial, 1, &[&tags]));
    let mut granule = 0u64;
    for (index, packet) in packets.iter().enumerate() {
        granule = granule.saturating_add(960);
        let flags = if index + 1 == packets.len() { 0x04 } else { 0 };
        out.extend(page(
            flags,
            granule,
            serial,
            (index as u32) + 2,
            &[packet.as_slice()],
        ));
    }
    out
}

fn opus_head() -> Vec<u8> {
    let mut head = b"OpusHead".to_vec();
    head.extend([1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    head
}

fn opus_tags() -> Vec<u8> {
    let vendor = b"buzz";
    let mut tags = b"OpusTags".to_vec();
    tags.extend((vendor.len() as u32).to_le_bytes());
    tags.extend(vendor);
    tags.extend(0u32.to_le_bytes());
    tags
}

fn page(flags: u8, granule: u64, serial: u32, sequence: u32, packets: &[&[u8]]) -> Vec<u8> {
    let mut segments = Vec::new();
    let mut body = Vec::new();
    for packet in packets {
        body.extend_from_slice(packet);
        let mut left = packet.len();
        while left >= 255 {
            segments.push(255);
            left -= 255;
        }
        segments.push(left as u8);
    }
    let mut page = b"OggS".to_vec();
    page.extend([0, flags]);
    page.extend(granule.to_le_bytes());
    page.extend(serial.to_le_bytes());
    page.extend(sequence.to_le_bytes());
    page.extend(0u32.to_le_bytes());
    page.push(segments.len() as u8);
    page.extend(&segments);
    page.extend(&body);
    let crc = ogg_crc(&page);
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    page
}

fn ogg_crc(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &byte in data {
        crc = (crc << 8) ^ crc_table()[((crc >> 24) as u8 ^ byte) as usize];
    }
    crc
}

fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let mut value = (index as u32) << 24;
        for _ in 0..8 {
            value = if value & 0x8000_0000 == 0 {
                value << 1
            } else {
                (value << 1) ^ 0x04c1_1db7
            };
        }
        *slot = value;
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_starts_with_an_opus_head_page() {
        let file = ogg_opus(&[vec![0x08, 0xff]]);
        assert_eq!(&file[..4], b"OggS");
        assert!(file.windows(8).any(|window| window == b"OpusHead"));
    }
}
