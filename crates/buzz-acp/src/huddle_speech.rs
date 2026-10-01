//! Join `/audio` when lifecycle says this agent is in the room, and speak replies.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use buzz_core::kind::{
    KIND_HUDDLE_ENDED, KIND_HUDDLE_PARTICIPANT_JOINED, KIND_HUDDLE_PARTICIPANT_LEFT,
    KIND_STREAM_MESSAGE,
};
use buzz_huddle_client::{next_retry_delay, opus_packets, play_packets, HuddleSession};
use buzz_ws_client::{NostrWsConnection, RelayMessage, WsClientError};
use nostr::{Event, Keys};
use serde_json::json;

use crate::huddle_tts::{fetch_opus, speech_config, SpeechConfig};
use crate::huddle_voice::{voice_cue, RoomIds, VoiceCue};

struct Seat {
    ephemeral: String,
    parent: String,
    session: HuddleSession,
}

/// Start the voice task when `VOICE_TTS_URL` is set. Otherwise do nothing.
pub fn spawn(relay_url: String, keys: Keys) {
    if speech_config().is_none() {
        return;
    }
    tokio::spawn(async move {
        if let Err(error) = run(&relay_url, &keys).await {
            tracing::warn!("huddle voice stopped: {error:#}");
        }
    });
}

async fn run(relay_url: &str, keys: &Keys) -> Result<()> {
    let mut attempt = 0u32;
    loop {
        match run_once(relay_url, keys).await {
            Ok(()) => return Ok(()),
            Err(error) => match next_retry_delay(attempt) {
                Some(delay) => {
                    tracing::warn!("huddle voice retrying after {error:#}");
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                }
                None => return Err(error),
            },
        }
    }
}

async fn run_once(relay_url: &str, keys: &Keys) -> Result<()> {
    let config = speech_config().context("VOICE_TTS_URL is unset")?;
    let mut conn = NostrWsConnection::connect_authenticated(relay_url, keys, None)
        .await
        .context("huddle voice relay auth")?;
    let self_pk = keys.public_key().to_hex();
    subscribe(&mut conn, &self_pk).await?;
    let mut seat = None;
    loop {
        drain_audio(&mut seat).await;
        match conn.next_event(Duration::from_millis(200)).await {
            Ok(RelayMessage::Event { event, .. }) => {
                apply(&mut seat, relay_url, keys, &config, &self_pk, &event).await;
            }
            Ok(RelayMessage::Closed { message, .. }) => {
                return Err(anyhow::anyhow!(
                    "huddle voice subscription closed: {message}"
                ));
            }
            Ok(_) | Err(WsClientError::Timeout) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

async fn drain_audio(seat: &mut Option<Seat>) {
    let Some(current) = seat.as_mut() else {
        return;
    };
    if let Ok(Err(_)) =
        tokio::time::timeout(Duration::from_millis(20), current.session.recv_audio()).await
    {
        *seat = None;
    }
}

async fn apply(
    seat: &mut Option<Seat>,
    relay_url: &str,
    keys: &Keys,
    config: &SpeechConfig,
    self_pk: &str,
    event: &Event,
) {
    match voice_cue(event, self_pk) {
        Some(VoiceCue::Join(room)) => join_room(seat, relay_url, keys, room).await,
        Some(VoiceCue::Leave(ephemeral))
            if seat
                .as_ref()
                .is_some_and(|current| current.ephemeral == ephemeral) =>
        {
            *seat = None;
        }
        Some(VoiceCue::Leave(_)) => {}
        Some(VoiceCue::Speak { channel, text }) => {
            speak(seat, config, self_pk, &channel, &text).await
        }
        None => {}
    }
}

async fn join_room(seat: &mut Option<Seat>, relay_url: &str, keys: &Keys, room: RoomIds) {
    if seat
        .as_ref()
        .is_some_and(|current| current.ephemeral == room.ephemeral)
    {
        return;
    }
    match HuddleSession::connect(relay_url, &room.ephemeral, &room.parent, keys).await {
        Ok(session) => {
            *seat = Some(Seat {
                ephemeral: room.ephemeral,
                parent: room.parent,
                session,
            });
        }
        Err(error) => tracing::warn!("huddle audio join failed: {error}"),
    }
}

async fn speak(
    seat: &mut Option<Seat>,
    config: &SpeechConfig,
    self_pk: &str,
    channel: &str,
    text: &str,
) {
    let Some(current) = seat.as_mut() else {
        return;
    };
    if channel != current.parent && channel != current.ephemeral {
        return;
    }
    let packets = match fetch_opus(config, text).await {
        Ok(bytes) => opus_packets(&bytes),
        Err(error) => {
            tracing::warn!("huddle tts failed: {error:#}");
            return;
        }
    };
    if packets.is_empty() {
        tracing::warn!("huddle tts returned no opus packets");
        return;
    }
    if play_packets(&mut current.session, &packets, self_pk, &config.agents)
        .await
        .is_err()
    {
        *seat = None;
    }
}

async fn subscribe(conn: &mut NostrWsConnection, pubkey: &str) -> Result<()> {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    conn.send_raw(&json!(["REQ", "huddle-life", {
        "kinds": [KIND_HUDDLE_PARTICIPANT_JOINED, KIND_HUDDLE_PARTICIPANT_LEFT, KIND_HUDDLE_ENDED],
        "#p": [pubkey],
        "limit": 20,
    }]))
    .await
    .context("huddle lifecycle subscribe")?;
    conn.send_raw(&json!(["REQ", "huddle-say", {
        "kinds": [KIND_STREAM_MESSAGE],
        "authors": [pubkey],
        "since": since,
    }]))
    .await
    .context("huddle reply subscribe")?;
    Ok(())
}
