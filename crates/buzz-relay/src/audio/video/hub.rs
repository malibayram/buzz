//! Track registry, limits, and subscriber queues.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use tokio::sync::mpsc;

use super::msgs::{self, ClientControl};
use super::types::{Occupant, VideoCtrl, VideoLease, CTRL_CAP, QUEUE_FRAMES};

/// Per-room camera and screen tracks. The relay does not decode them.
pub struct VideoHub {
    inner: Mutex<Inner>,
}

pub(super) struct Inner {
    pub(super) revision: u64,
    pub(super) next_gen: u64,
    pub(super) people: HashMap<(u8, u8), Occupant>,
}

impl Default for VideoHub {
    fn default() -> Self {
        Self::new()
    }
}

impl VideoHub {
    /// Empty registry.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                revision: 0,
                next_gen: 1,
                people: HashMap::new(),
            }),
        }
    }

    /// Replace any socket already bound to this occupancy.
    pub fn bind(&self, index: u8, epoch: u8, pubkey: String) -> VideoLease {
        let mut g = lock(&self.inner);
        g.remove_occupant(index, epoch);
        let generation = g.next_gen;
        g.next_gen = g.next_gen.wrapping_add(1);
        let (media_tx, media_rx) = mpsc::channel(QUEUE_FRAMES);
        let (ctrl_tx, ctrl_rx) = mpsc::channel(CTRL_CAP);
        g.people.insert(
            (index, epoch),
            Occupant {
                pubkey,
                generation,
                media_tx,
                ctrl_tx,
                frames: 0,
                bytes: 0,
                tracks: HashMap::new(),
                desired: HashMap::new(),
                keyframe_at: HashMap::new(),
            },
        );
        let snapshot = g.snapshot();
        VideoLease {
            generation,
            media_rx,
            ctrl_rx,
            snapshot,
        }
    }

    /// Drop the socket only when `generation` is still current.
    pub fn unbind(&self, index: u8, epoch: u8, generation: u64) {
        let mut g = lock(&self.inner);
        if g.generation(index, epoch) == Some(generation) {
            g.remove_occupant(index, epoch);
        }
    }

    /// Drop video for one audio occupancy, whatever generation it is.
    pub fn clear_occupancy(&self, index: u8, epoch: u8) {
        lock(&self.inner).remove_occupant(index, epoch);
    }

    /// Drop video bound to older epochs of `index`.
    pub fn retire_other_epochs(&self, index: u8, epoch: u8) {
        let mut g = lock(&self.inner);
        let stale: Vec<u8> = g
            .people
            .keys()
            .filter(|(i, e)| *i == index && *e != epoch)
            .map(|(_, e)| *e)
            .collect();
        for old in stale {
            g.remove_occupant(index, old);
        }
    }

    /// Drop every video socket in the room.
    pub fn clear_all(&self) {
        let mut g = lock(&self.inner);
        let keys: Vec<(u8, u8)> = g.people.keys().copied().collect();
        for (index, epoch) in keys {
            g.remove_occupant(index, epoch);
        }
    }

    /// Apply one client control message for the current generation.
    pub fn handle_control(&self, index: u8, epoch: u8, generation: u64, text: &str) {
        let parsed = match msgs::parse_client(text) {
            Ok(msg) => msg,
            Err(code) => {
                self.send_error(index, epoch, generation, code);
                return;
            }
        };
        let mut g = lock(&self.inner);
        if g.generation(index, epoch) != Some(generation) {
            return;
        }
        match parsed {
            ClientControl::Publish {
                track,
                codec,
                layers,
            } => g.publish(index, epoch, track, codec, layers),
            ClientControl::Unpublish { track } => g.unpublish(index, epoch, track),
            ClientControl::Subscribe {
                peer_index,
                epoch: pub_epoch,
                track,
                layer,
            } => g.subscribe(
                (index, epoch),
                (peer_index, pub_epoch, track),
                layer,
                Instant::now(),
            ),
        }
    }

    /// Forward one encoded access unit, or ask for a keyframe after a drop.
    pub fn push_frame(&self, index: u8, epoch: u8, generation: u64, frame: &[u8]) {
        lock(&self.inner).push_frame(index, epoch, generation, frame, Instant::now());
    }

    /// Tell the publisher a frame exceeded the cap and wait for a keyframe.
    pub fn note_oversize(&self, index: u8, epoch: u8, generation: u64, frame: &[u8]) {
        lock(&self.inner).note_oversize(index, epoch, generation, frame, Instant::now());
    }

    /// Return queue budget after a frame has been written to the socket.
    pub fn release(&self, index: u8, epoch: u8, generation: u64, len: usize) {
        let mut g = lock(&self.inner);
        if g.generation(index, epoch) != Some(generation) {
            return;
        }
        if let Some(occ) = g.people.get_mut(&(index, epoch)) {
            occ.frames = occ.frames.saturating_sub(1);
            occ.bytes = occ.bytes.saturating_sub(len);
        }
    }

    fn send_error(&self, index: u8, epoch: u8, generation: u64, code: &str) {
        let g = lock(&self.inner);
        if g.generation(index, epoch) != Some(generation) {
            return;
        }
        if let Some(occ) = g.people.get(&(index, epoch)) {
            let _ = occ.ctrl_tx.try_send(VideoCtrl::Text(msgs::error_msg(code)));
        }
    }
}

pub(super) fn lock(inner: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|p| p.into_inner())
}
