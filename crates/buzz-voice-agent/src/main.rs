//! Huddle scribe. Follows huddle lifecycle in every channel this identity
//! belongs to, joins each room a person enters, transcribes each speaker, and
//! posts a speaker-tagged kind 9 in the huddle channel.
//!
//! A failed STT call is logged and never posted. The scribe leaves a room once
//! no people remain, so it never keeps an empty huddle alive.

mod ogg;
mod rooms;
mod segment;
mod transcript;

use std::collections::{HashMap, VecDeque};
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use buzz_core::kind::{KIND_HUDDLE_ENDED, KIND_HUDDLE_PARTICIPANT_JOINED};
use buzz_huddle_client::{next_retry_delay, HuddleSession};
use buzz_ws_client::{publish_event, NostrWsConnection, RelayMessage, WsClientError};
use nostr::Keys;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use rooms::{cue, is_person, Cue};
use segment::{Segmenter, Utterance, HANGOVER};

/// Most rooms transcribed at once. STT is the bottleneck, not sockets.
const MAX_ROOMS: usize = 8;
/// Utterances waiting for STT per room before new ones are dropped.
const STT_QUEUE: usize = 16;
/// How often the lifecycle subscription is renewed, so channels the scribe
/// joined after startup are covered.
const RESUBSCRIBE: Duration = Duration::from_secs(60);
/// How far a renewed subscription reaches back, so renewals overlap.
const RESUBSCRIBE_OVERLAP_SECS: u64 = 30;
/// Lifecycle event ids remembered, so an overlapping renewal that replays a
/// join cannot pull the scribe back into a room it just left.
const SEEN_EVENTS: usize = 256;
/// Longest wait for audio before checking for quiet speakers and an empty room.
const TICK: Duration = Duration::from_millis(100);

struct Config {
    relay_url: String,
    keys: Keys,
    self_pubkey: String,
    http: reqwest::Client,
    stt_url: String,
    api_key: Option<String>,
    stt_model: String,
    stt_language: Option<String>,
    agents: Vec<String>,
}

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            eprintln!("buzz-voice-agent: {error}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "buzz-voice-agent: scribe {} transcribing with {}",
        config.self_pubkey, config.stt_url
    );
    // Rooms outlive a lost lifecycle connection: their audio sockets are
    // separate, and a reconnect must not join the same room twice.
    let mut rooms = HashMap::new();
    let mut seen = VecDeque::with_capacity(SEEN_EVENTS);
    let mut attempt = 0u32;
    loop {
        let started = Instant::now();
        let error = watch(&config, &mut rooms, &mut seen).await;
        eprintln!("buzz-voice-agent: {error}");
        if started.elapsed() > RESUBSCRIBE {
            attempt = 0;
        }
        let Some(delay) = next_retry_delay(attempt) else {
            eprintln!("buzz-voice-agent: giving up after repeated failures");
            std::process::exit(1);
        };
        attempt += 1;
        tokio::time::sleep(delay).await;
    }
}

/// Follow lifecycle events until the relay connection fails.
async fn watch(
    config: &Arc<Config>,
    rooms: &mut HashMap<String, JoinHandle<()>>,
    seen: &mut VecDeque<nostr::EventId>,
) -> String {
    let mut conn =
        match NostrWsConnection::connect_authenticated(&config.relay_url, &config.keys, None).await
        {
            Ok(conn) => conn,
            Err(error) => return format!("relay connect failed: {error}"),
        };
    let mut since = unix_now();
    let mut subscribed_at: Option<Instant> = None;
    loop {
        if subscribed_at.is_none_or(|at| at.elapsed() >= RESUBSCRIBE) {
            if let Err(error) = subscribe(&mut conn, since).await {
                return format!("lifecycle subscribe failed: {error}");
            }
            subscribed_at = Some(Instant::now());
            since = unix_now().saturating_sub(RESUBSCRIBE_OVERLAP_SECS);
        }
        let event = match conn.next_event(Duration::from_secs(1)).await {
            Ok(RelayMessage::Event { event, .. }) => event,
            Ok(RelayMessage::Closed { message, .. }) => {
                return format!("lifecycle subscription closed: {message}");
            }
            Ok(_) | Err(WsClientError::Timeout) => continue,
            Err(error) => return format!("relay connection lost: {error}"),
        };
        if seen.contains(&event.id) {
            continue;
        }
        if seen.len() == SEEN_EVENTS {
            seen.pop_front();
        }
        seen.push_back(event.id);
        rooms.retain(|_, room| !room.is_finished());
        match cue(&event, &config.self_pubkey, &config.agents) {
            Some(Cue::Join { ephemeral, parent }) => {
                if rooms.contains_key(&ephemeral) {
                    continue;
                }
                if rooms.len() >= MAX_ROOMS {
                    eprintln!("buzz-voice-agent: {MAX_ROOMS} rooms already; skipping {ephemeral}");
                    continue;
                }
                let room = tokio::spawn(attend(config.clone(), ephemeral.clone(), parent));
                rooms.insert(ephemeral, room);
            }
            Some(Cue::End { ephemeral }) => {
                if let Some(room) = rooms.remove(&ephemeral) {
                    room.abort();
                }
            }
            None => {}
        }
    }
}

async fn subscribe(conn: &mut NostrWsConnection, since: u64) -> Result<(), WsClientError> {
    conn.send_raw(&json!(["REQ", "huddle-scribe", {
        "kinds": [KIND_HUDDLE_PARTICIPANT_JOINED, KIND_HUDDLE_ENDED],
        "since": since,
    }]))
    .await
}

/// Sit in one room until it ends, empties of people, or the socket fails.
async fn attend(config: Arc<Config>, ephemeral: String, parent: String) {
    let mut session =
        match HuddleSession::connect(&config.relay_url, &ephemeral, &parent, &config.keys).await {
            Ok(session) => session,
            Err(error) => {
                eprintln!("buzz-voice-agent: join {ephemeral} failed: {error}");
                return;
            }
        };
    eprintln!("buzz-voice-agent: joined huddle {ephemeral}");
    let (queue, pending) = mpsc::channel(STT_QUEUE);
    tokio::spawn(post_transcripts(config.clone(), ephemeral.clone(), pending));
    let mut segments = Segmenter::default();
    let person = |pubkey: &str| is_person(pubkey, &config.self_pubkey, &config.agents);
    while session.occupants().any(person) {
        let frame = match tokio::time::timeout(TICK, session.recv_audio()).await {
            Err(_) => None,
            Ok(Ok(frame)) => Some(frame),
            Ok(Err(error)) => {
                eprintln!("buzz-voice-agent: huddle {ephemeral} audio ended: {error}");
                break;
            }
        };
        let now = Instant::now();
        let mut done = segments.flush_quiet(now);
        if let Some(frame) = frame {
            if let Some(speaker) = session
                .pubkey(frame.peer_index, frame.epoch)
                .filter(|speaker| person(speaker))
                .map(str::to_string)
            {
                done.extend(segments.push(&speaker, frame.header.level_dbov, frame.opus, now));
            }
        }
        enqueue(&queue, done);
    }
    enqueue(&queue, segments.flush_quiet(Instant::now() + HANGOVER));
    eprintln!("buzz-voice-agent: left huddle {ephemeral}");
}

fn enqueue(queue: &mpsc::Sender<Utterance>, utterances: Vec<Utterance>) {
    for utterance in utterances {
        if queue.try_send(utterance).is_err() {
            eprintln!("buzz-voice-agent: STT is behind; dropped an utterance");
        }
    }
}

/// Transcribe and post one room's utterances in the order they were spoken.
async fn post_transcripts(
    config: Arc<Config>,
    channel_id: String,
    mut pending: mpsc::Receiver<Utterance>,
) {
    while let Some(utterance) = pending.recv().await {
        let text = match transcribe(&config, &ogg::ogg_opus(&utterance.packets)).await {
            Ok(text) => text,
            Err(error) => {
                eprintln!("buzz-voice-agent: {error}");
                continue;
            }
        };
        let Some(event) = transcript::transcript_event(
            &config.keys,
            &channel_id,
            &utterance.speaker,
            &config.agents,
            &text,
        ) else {
            continue;
        };
        match publish_event(&config.relay_url, event, &config.keys, None, 15).await {
            Ok(ok) if !ok.accepted => {
                eprintln!("buzz-voice-agent: transcript rejected: {}", ok.message);
            }
            Ok(_) => {}
            Err(error) => eprintln!("buzz-voice-agent: transcript post failed: {error}"),
        }
    }
}

async fn transcribe(config: &Config, ogg: &[u8]) -> Result<String, String> {
    let mut last = String::from("stt failed");
    for _ in 0..2 {
        let part = reqwest::multipart::Part::bytes(ogg.to_vec())
            .file_name("speech.ogg")
            .mime_str("audio/ogg")
            .map_err(|error| error.to_string())?;
        let mut form = reqwest::multipart::Form::new()
            .text("model", config.stt_model.clone())
            .part("file", part);
        if let Some(language) = &config.stt_language {
            form = form.text("language", language.clone());
        }
        let mut request = config.http.post(&config.stt_url).multipart(form);
        if let Some(key) = &config.api_key {
            request = request.bearer_auth(key);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let body: serde_json::Value =
                    response.json().await.map_err(|error| error.to_string())?;
                let text = body
                    .get("text")
                    .and_then(|text| text.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if text.is_empty() {
                    return Err("stt returned an empty transcript".into());
                }
                return Ok(text);
            }
            Ok(response) => last = format!("stt status {}", response.status()),
            Err(error) => last = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(last)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|now| now.as_secs())
        .unwrap_or(0)
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let secret = env::var("BUZZ_PRIVATE_KEY").map_err(|_| "BUZZ_PRIVATE_KEY is required")?;
        let keys = Keys::parse(&secret).map_err(|_| "BUZZ_PRIVATE_KEY is invalid")?;
        Ok(Self {
            relay_url: env::var("BUZZ_RELAY_URL").map_err(|_| "BUZZ_RELAY_URL is required")?,
            self_pubkey: keys.public_key().to_hex(),
            keys,
            http: reqwest::Client::new(),
            stt_url: env::var("VOICE_STT_URL").map_err(|_| "VOICE_STT_URL is required")?,
            api_key: optional("VOICE_API_KEY"),
            stt_model: optional("VOICE_STT_MODEL").unwrap_or_else(|| "whisper-1".into()),
            stt_language: optional("VOICE_STT_LANGUAGE"),
            agents: env::var("BUZZ_HUDDLE_AGENTS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect(),
        })
    }
}
