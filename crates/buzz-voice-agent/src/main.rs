//! Joins one huddle audio room, transcribes speech, and posts kind 9.
//!
//! The harness speaks through `VOICE_TTS_URL` in a later step. This process
//! only transcribes. A failed STT call is counted and never posted.

mod ogg;
mod transcript;

use std::env;
use std::time::Duration;

use buzz_huddle_client::{next_retry_delay, HuddleSession};
use buzz_ws_client::publish_event;
use nostr::Keys;

struct Config {
    relay_url: String,
    keys: Keys,
    stt_url: String,
    tts_url: String,
    api_key: String,
    stt_model: String,
    channel_id: String,
    parent_channel_id: String,
    agents: Vec<String>,
}

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(config) => {
            eprintln!("buzz-voice-agent: speech replies use {}", config.tts_url);
            config
        }
        Err(error) => {
            eprintln!("buzz-voice-agent: {error}");
            std::process::exit(1);
        }
    };
    let mut attempt = 0u32;
    loop {
        match listen(&config).await {
            Ok(()) => attempt = 0,
            Err(error) => {
                eprintln!("buzz-voice-agent: {error}");
                let Some(delay) = next_retry_delay(attempt) else {
                    eprintln!("buzz-voice-agent: giving up after repeated failures");
                    std::process::exit(1);
                };
                attempt += 1;
                tokio::time::sleep(delay).await;
            }
        }
    }
}

async fn listen(config: &Config) -> Result<(), String> {
    let mut session = HuddleSession::connect(
        &config.relay_url,
        &config.channel_id,
        &config.parent_channel_id,
        &config.keys,
    )
    .await
    .map_err(|error| error.to_string())?;
    let mut speech: std::collections::HashMap<(u8, u8), Vec<Vec<u8>>> =
        std::collections::HashMap::new();
    loop {
        let frame = session
            .recv_audio()
            .await
            .map_err(|error| error.to_string())?;
        let key = (frame.peer_index, frame.epoch);
        if frame.header.level_dbov > -40 {
            speech.entry(key).or_default().push(frame.opus);
            continue;
        }
        let Some(opus) = speech.remove(&key) else {
            continue;
        };
        let Some(speaker) = session
            .pubkey(frame.peer_index, frame.epoch)
            .map(str::to_string)
        else {
            continue;
        };
        let text = match transcribe(config, &ogg::ogg_opus(&opus)).await {
            Ok(text) => text,
            Err(error) => {
                eprintln!("buzz-voice-agent: {error}");
                continue;
            }
        };
        let Some(event) = transcript::transcript_event(
            &config.keys,
            &config.channel_id,
            &speaker,
            &config.agents,
            &text,
        ) else {
            continue;
        };
        if let Err(error) = publish_event(&config.relay_url, event, &config.keys, None, 15).await {
            eprintln!("buzz-voice-agent: transcript post failed: {error}");
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
        let form = reqwest::multipart::Form::new()
            .text("model", config.stt_model.clone())
            .part("file", part);
        let response = reqwest::Client::new()
            .post(&config.stt_url)
            .bearer_auth(&config.api_key)
            .multipart(form)
            .send()
            .await;
        match response {
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

impl Config {
    fn from_env() -> Result<Self, String> {
        let secret = env::var("BUZZ_PRIVATE_KEY").map_err(|_| "BUZZ_PRIVATE_KEY is required")?;
        Ok(Self {
            relay_url: env::var("BUZZ_RELAY_URL").map_err(|_| "BUZZ_RELAY_URL is required")?,
            keys: Keys::parse(&secret).map_err(|_| "BUZZ_PRIVATE_KEY is invalid")?,
            stt_url: env::var("VOICE_STT_URL").map_err(|_| "VOICE_STT_URL is required")?,
            tts_url: env::var("VOICE_TTS_URL").map_err(|_| "VOICE_TTS_URL is required")?,
            api_key: env::var("VOICE_API_KEY").map_err(|_| "VOICE_API_KEY is required")?,
            stt_model: env::var("VOICE_STT_MODEL").unwrap_or_else(|_| "whisper-1".into()),
            channel_id: env::var("BUZZ_HUDDLE_CHANNEL_ID")
                .map_err(|_| "BUZZ_HUDDLE_CHANNEL_ID is required")?,
            parent_channel_id: env::var("BUZZ_PARENT_CHANNEL_ID")
                .map_err(|_| "BUZZ_PARENT_CHANNEL_ID is required")?,
            agents: env::var("BUZZ_HUDDLE_AGENTS")
                .unwrap_or_default()
                .split(',')
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect(),
        })
    }
}
