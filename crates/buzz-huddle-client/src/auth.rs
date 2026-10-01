//! NIP-42 huddle auth. The relay tag is the community relay, not the audio URL.

use buzz_ws_client::build_auth_event;
use nostr::Keys;
use serde_json::{json, Value};
use url::Url;

use crate::error::ClientError;

/// `ws(s)://relay/huddle/{channel}/audio`.
pub fn audio_url(relay_url: &str, channel_id: &str) -> Result<Url, ClientError> {
    let base = Url::parse(relay_url).map_err(|_| ClientError::Url)?;
    if base.scheme() != "ws" && base.scheme() != "wss" {
        return Err(ClientError::Url);
    }
    let mut url = base;
    url.set_path(&format!(
        "/huddle/{}/audio",
        urlencoding_channel(channel_id)
    ));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Auth text sent after the huddle challenge.
pub fn auth_message(
    keys: &Keys,
    relay_url: &str,
    parent_channel_id: &str,
    challenge: &str,
) -> Result<String, ClientError> {
    let event = build_auth_event(challenge, relay_url, keys, None)?;
    let body = json!({
        "type": "auth",
        "event": event,
        "parent_channel_id": parent_channel_id,
        "protocol_version": 4,
    });
    Ok(body.to_string())
}

/// Parse a huddle text frame. Returns the challenge string when present.
pub fn challenge_of(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("type")?.as_str()? != "challenge" {
        return None;
    }
    let challenge = value.get("challenge")?.as_str()?.to_string();
    if challenge.is_empty() {
        None
    } else {
        Some(challenge)
    }
}

fn urlencoding_channel(channel_id: &str) -> String {
    url::form_urlencoded::byte_serialize(channel_id.as_bytes()).collect()
}
