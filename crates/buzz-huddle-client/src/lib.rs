//! Client for a Buzz huddle audio room.
//!
//! Video stays on its own socket. This crate speaks protocol v4: the same
//! eight-byte header as earlier versions, with a peer index and occupancy
//! epoch on frames from the relay.

#![deny(unsafe_code)]

mod auth;
mod error;
mod ogg;
mod play;
mod roster;
mod session;
mod wire;

pub use auth::{audio_url, auth_message};
pub use error::ClientError;
pub use ogg::opus_packets;
pub use play::{play_packets, should_barge, BARGE_LEVEL_DBOV};
pub use session::{next_retry_delay, HuddleSession};
pub use wire::{decode_relay_frame, encode_client_frame, AudioHeader, RemoteAudio};
