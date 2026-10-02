//! Shared video-SFU types. The relay never decodes H.264.

use std::collections::HashMap;
use std::time::Instant;

use bytes::Bytes;
use tokio::sync::mpsc;

/// Application cap for one encoded access unit, including the 12-byte header.
pub const VIDEO_MAX_FRAME_BYTES: usize = 512 * 1024;
/// Per-subscriber media queue, in frames. Separate from the audio queue.
/// Sized for latency, not throughput: a viewer that falls behind drops to the
/// next keyframe instead of buffering seconds of video that would compete
/// with huddle audio on the same downlink.
pub const QUEUE_FRAMES: usize = 16;
/// Per-subscriber media queue, in bytes. Must exceed `VIDEO_MAX_FRAME_BYTES`
/// so a maximal keyframe can always be admitted to an empty queue.
pub const QUEUE_BYTES: usize = 768 * 1024;
pub const MAX_CAMERAS: usize = 8;
pub const KEYFRAME_MIN: std::time::Duration = std::time::Duration::from_millis(500);
pub const CTRL_CAP: usize = 32;
pub const TRACK_CAMERA: u8 = 0;
pub const TRACK_SCREEN: u8 = 1;
pub const CODEC_AVC: &str = "avc1.42E01F";
/// Video sockets speak protocol v4 only. v4 audio frames match v3.
pub const REQUIRED_PROTOCOL: u8 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerDesc {
    pub layer: u8,
    pub width: u16,
    pub height: u16,
    pub max_kbps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackDesc {
    pub track: u8,
    pub codec: String,
    pub layers: Vec<LayerDesc>,
}

#[derive(Debug)]
pub enum VideoCtrl {
    Text(String),
    Close,
}

#[derive(Clone, Copy, Debug)]
pub struct Desired {
    pub layer: u8,
    pub needs_keyframe: bool,
}

pub(super) struct Occupant {
    pub pubkey: String,
    pub generation: u64,
    pub media_tx: mpsc::Sender<Bytes>,
    pub ctrl_tx: mpsc::Sender<VideoCtrl>,
    pub frames: usize,
    pub bytes: usize,
    pub tracks: HashMap<u8, TrackDesc>,
    /// Keyed by `(publisher_index, publisher_epoch, track)`.
    pub desired: HashMap<(u8, u8, u8), Desired>,
    pub keyframe_at: HashMap<(u8, u8), Instant>,
}

pub struct VideoLease {
    pub generation: u64,
    pub media_rx: mpsc::Receiver<Bytes>,
    pub ctrl_rx: mpsc::Receiver<VideoCtrl>,
    pub snapshot: String,
}
