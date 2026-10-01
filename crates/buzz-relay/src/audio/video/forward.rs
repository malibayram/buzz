//! Layer selection, drop-until-keyframe, and bounded per-subscriber queues.

use std::time::Instant;

use super::header::{classify_inbound, prefix_relay_frame, InboundFrame, VideoFrameHeader};
use super::hub::Inner;
use super::msgs;
use super::types::{QUEUE_BYTES, QUEUE_FRAMES};

impl Inner {
    pub(super) fn push_frame(
        &mut self,
        index: u8,
        epoch: u8,
        generation: u64,
        frame: &[u8],
        now: Instant,
    ) {
        if self.generation(index, epoch) != Some(generation) {
            return;
        }
        let InboundFrame::Media(_) = classify_inbound(frame) else {
            if matches!(classify_inbound(frame), InboundFrame::Oversize) {
                self.note_oversize(index, epoch, generation, frame, now);
            }
            return;
        };
        let Some((header, _)) = VideoFrameHeader::parse(frame) else {
            return;
        };
        if !self.layer_published(index, epoch, header.track, header.layer) {
            return;
        }
        let targets: Vec<(u8, u8)> = self
            .people
            .keys()
            .copied()
            .filter(|k| *k != (index, epoch))
            .collect();
        for key in targets {
            self.forward_one(key, index, epoch, header, frame, now);
        }
    }

    pub(super) fn note_oversize(
        &mut self,
        index: u8,
        epoch: u8,
        generation: u64,
        frame: &[u8],
        now: Instant,
    ) {
        if self.generation(index, epoch) != Some(generation) {
            return;
        }
        let parsed = VideoFrameHeader::parse(frame);
        let text = match parsed {
            Some((h, _)) => msgs::error_frame("frame_too_large", h.track, h.layer),
            None => msgs::error_msg("frame_too_large"),
        };
        self.send_text(index, epoch, text);
        if let Some((h, _)) = parsed {
            self.mark_needs_keyframe(index, epoch, h.track, h.layer);
            self.ask_keyframe(index, epoch, h.track, h.layer, now);
        }
    }

    fn forward_one(
        &mut self,
        dest: (u8, u8),
        index: u8,
        epoch: u8,
        header: VideoFrameHeader,
        frame: &[u8],
        now: Instant,
    ) {
        let key = (index, epoch, header.track);
        let Some(desired) = self
            .people
            .get(&dest)
            .and_then(|o| o.desired.get(&key).copied())
        else {
            return;
        };
        if desired.layer != header.layer {
            return;
        }
        if desired.needs_keyframe && !header.is_keyframe() {
            self.ask_keyframe(index, epoch, header.track, header.layer, now);
            return;
        }
        let prefixed = prefix_relay_frame(index, epoch, frame);
        let queued = self
            .people
            .get_mut(&dest)
            .is_some_and(|occ| enqueue(occ, prefixed));
        if !queued {
            if let Some(slot) = self
                .people
                .get_mut(&dest)
                .and_then(|o| o.desired.get_mut(&key))
            {
                slot.needs_keyframe = true;
            }
            self.ask_keyframe(index, epoch, header.track, header.layer, now);
            return;
        }
        if header.is_keyframe() {
            if let Some(slot) = self
                .people
                .get_mut(&dest)
                .and_then(|o| o.desired.get_mut(&key))
            {
                slot.needs_keyframe = false;
            }
        }
    }

    fn layer_published(&self, index: u8, epoch: u8, track: u8, layer: u8) -> bool {
        self.people.get(&(index, epoch)).is_some_and(|occ| {
            occ.tracks
                .get(&track)
                .is_some_and(|t| t.layers.iter().any(|l| l.layer == layer))
        })
    }

    fn mark_needs_keyframe(&mut self, index: u8, epoch: u8, track: u8, layer: u8) {
        let key = (index, epoch, track);
        for occ in self.people.values_mut() {
            if let Some(slot) = occ.desired.get_mut(&key) {
                if slot.layer == layer {
                    slot.needs_keyframe = true;
                }
            }
        }
    }
}

fn enqueue(occ: &mut super::types::Occupant, frame: bytes::Bytes) -> bool {
    let len = frame.len();
    if occ.frames >= QUEUE_FRAMES || occ.bytes.saturating_add(len) > QUEUE_BYTES {
        return false;
    }
    if occ.media_tx.try_send(frame).is_err() {
        return false;
    }
    occ.frames += 1;
    occ.bytes += len;
    true
}
