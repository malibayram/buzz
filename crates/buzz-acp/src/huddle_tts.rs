//! OpenAI-compatible `/v1/audio/speech` client. The response is Ogg Opus.

use std::collections::HashSet;

use anyhow::{Context, Result};
use serde_json::json;

pub struct SpeechConfig {
    pub tts_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub agents: HashSet<String>,
}

pub fn speech_config() -> Option<SpeechConfig> {
    let tts_url = std::env::var("VOICE_TTS_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())?;
    let agents = std::env::var("BUZZ_HUDDLE_AGENTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    Some(SpeechConfig {
        tts_url,
        api_key: std::env::var("VOICE_API_KEY")
            .ok()
            .filter(|key| !key.is_empty()),
        model: std::env::var("VOICE_TTS_MODEL").unwrap_or_else(|_| "tts-1".into()),
        agents,
    })
}

pub async fn fetch_opus(config: &SpeechConfig, text: &str) -> Result<Vec<u8>> {
    let input: String = text.chars().take(4_000).collect();
    let mut request = reqwest::Client::new().post(&config.tts_url).json(&json!({
        "model": config.model,
        "input": input,
        "voice": "alloy",
        "response_format": "opus",
    }));
    if let Some(key) = &config.api_key {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.context("tts request")?;
    if !response.status().is_success() {
        anyhow::bail!("tts status {}", response.status());
    }
    Ok(response.bytes().await.context("tts body")?.to_vec())
}
