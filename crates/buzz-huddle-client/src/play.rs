//! Pace Opus packets onto the audio socket and stop when a person talks over them.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::error::ClientError;
use crate::session::HuddleSession;
use crate::wire::AudioHeader;

/// A frame louder than this, from someone who is not an agent, stops playback.
pub const BARGE_LEVEL_DBOV: i8 = -40;

/// Whether `speaker` talking at `level_dbov` should interrupt this agent.
pub fn should_barge(
    level_dbov: i8,
    speaker: Option<&str>,
    self_pubkey: &str,
    agents: &HashSet<String>,
) -> bool {
    let Some(speaker) = speaker.map(str::to_ascii_lowercase) else {
        return false;
    };
    if speaker == self_pubkey.to_ascii_lowercase() || agents.contains(&speaker) {
        return false;
    }
    level_dbov > BARGE_LEVEL_DBOV
}

/// Send `packets` at 20 ms. Returns true when playback stopped for barge-in.
pub async fn play_packets(
    session: &mut HuddleSession,
    packets: &[Vec<u8>],
    self_pubkey: &str,
    agents: &HashSet<String>,
) -> Result<bool, ClientError> {
    let mut sequence = 0u16;
    let mut timestamp = 0u32;
    for (index, packet) in packets.iter().enumerate() {
        session
            .send_frame(
                AudioHeader {
                    sequence,
                    timestamp_48k: timestamp,
                    level_dbov: -20,
                    flags: 0,
                },
                packet,
            )
            .await?;
        sequence = sequence.wrapping_add(1);
        timestamp = timestamp.wrapping_add(960);
        if index + 1 == packets.len() {
            break;
        }
        if pace(session, self_pubkey, agents).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn pace(
    session: &mut HuddleSession,
    self_pubkey: &str,
    agents: &HashSet<String>,
) -> Result<bool, ClientError> {
    let deadline = Instant::now() + Duration::from_millis(20);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        match tokio::time::timeout(remaining, session.recv_audio()).await {
            Ok(Ok(frame)) => {
                let speaker = session.pubkey(frame.peer_index, frame.epoch);
                if should_barge(frame.header.level_dbov, speaker, self_pubkey, agents) {
                    return Ok(true);
                }
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_person_above_the_threshold_barges() {
        let agents = HashSet::from(["aa".repeat(32)]);
        let human = "bb".repeat(32);
        assert!(should_barge(-20, Some(&human), &"cc".repeat(32), &agents));
        assert!(!should_barge(-40, Some(&human), &"cc".repeat(32), &agents));
        assert!(!should_barge(
            -20,
            agents.iter().next().map(String::as_str),
            &"cc".repeat(32),
            &agents
        ));
    }
}
