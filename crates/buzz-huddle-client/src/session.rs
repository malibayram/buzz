//! One huddle audio socket, plus the reconnect schedule the caller applies.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostr::Keys;
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::auth::{audio_url, auth_message, challenge_of};
use crate::error::ClientError;
use crate::roster::apply_roster;
use crate::wire::{decode_relay_frame, encode_client_frame, AudioHeader, RemoteAudio};

/// Delay before retry `attempt` (0-based). `None` means stop retrying.
pub fn next_retry_delay(attempt: u32) -> Option<Duration> {
    const DELAYS_MS: [u64; 6] = [0, 100, 250, 500, 1_000, 2_000];
    DELAYS_MS
        .get(attempt as usize)
        .copied()
        .map(Duration::from_millis)
}

/// An admitted audio socket.
pub struct HuddleSession {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    peers: HashMap<(u8, u8), String>,
}

impl HuddleSession {
    /// Connect, answer the challenge, and wait until the relay sends `joined`.
    pub async fn connect(
        relay_url: &str,
        channel_id: &str,
        parent_channel_id: &str,
        keys: &Keys,
    ) -> Result<Self, ClientError> {
        let url = audio_url(relay_url, channel_id)?;
        let (mut socket, _) = connect_async(url.as_str())
            .await
            .map_err(|error| ClientError::Connect(error.to_string()))?;
        let challenge = next_text(&mut socket).await?;
        let Some(challenge) = challenge_of(&challenge) else {
            return Err(ClientError::Rejected("missing challenge".into()));
        };
        let auth = auth_message(keys, relay_url, parent_channel_id, &challenge)?;
        socket
            .send(Message::Text(auth.into()))
            .await
            .map_err(|error| ClientError::Connect(error.to_string()))?;
        loop {
            let text = next_text(&mut socket).await?;
            let value: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| ClientError::Rejected(text.clone()))?;
            match value.get("type").and_then(|kind| kind.as_str()) {
                Some("joined") => {
                    let mut peers = HashMap::new();
                    apply_roster(&mut peers, &value);
                    return Ok(Self { socket, peers });
                }
                Some("error") => {
                    let code = value
                        .get("code")
                        .and_then(|code| code.as_str())
                        .unwrap_or("error");
                    return Err(ClientError::Rejected(code.to_string()));
                }
                _ => {}
            }
        }
    }

    /// Read the next decoded audio frame. Control text is skipped except errors.
    pub async fn recv_audio(&mut self) -> Result<RemoteAudio, ClientError> {
        loop {
            match self
                .socket
                .next()
                .await
                .ok_or_else(|| ClientError::Connect("closed".into()))?
                .map_err(|error| ClientError::Connect(error.to_string()))?
            {
                Message::Binary(bytes) => {
                    if let Ok(frame) = decode_relay_frame(&bytes) {
                        return Ok(frame);
                    }
                }
                Message::Text(text) => {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                        if value.get("type").and_then(|kind| kind.as_str()) == Some("error") {
                            let code = value
                                .get("code")
                                .and_then(|code| code.as_str())
                                .unwrap_or("error");
                            return Err(ClientError::Rejected(code.to_string()));
                        }
                        apply_roster(&mut self.peers, &value);
                    }
                }
                Message::Close(_) => return Err(ClientError::Connect("closed".into())),
                _ => {}
            }
        }
    }

    /// Send one client audio frame. Opus bytes stay opaque.
    pub async fn send_frame(
        &mut self,
        header: AudioHeader,
        opus: &[u8],
    ) -> Result<(), ClientError> {
        let bytes =
            encode_client_frame(header, opus).map_err(|_| ClientError::Rejected("frame".into()))?;
        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|error| ClientError::Connect(error.to_string()))
    }

    /// Pubkey that currently occupies this index and epoch.
    pub fn pubkey(&self, peer_index: u8, epoch: u8) -> Option<&str> {
        self.peers.get(&(peer_index, epoch)).map(String::as_str)
    }

    /// Pubkeys of everyone currently in the room, this session included.
    pub fn occupants(&self) -> impl Iterator<Item = &str> {
        self.peers.values().map(String::as_str)
    }
}

async fn next_text(
    socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
) -> Result<String, ClientError> {
    loop {
        match socket
            .next()
            .await
            .ok_or_else(|| ClientError::Connect("closed".into()))?
            .map_err(|error| ClientError::Connect(error.to_string()))?
        {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Close(_) => return Err(ClientError::Connect("closed".into())),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_stop_after_the_schedule() {
        assert_eq!(next_retry_delay(0), Some(Duration::ZERO));
        assert_eq!(next_retry_delay(5), Some(Duration::from_millis(2_000)));
        assert_eq!(next_retry_delay(6), None);
    }
}
