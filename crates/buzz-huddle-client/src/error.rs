//! Errors from the huddle audio client.

use thiserror::Error;

/// Failure while opening or using the audio socket.
#[derive(Debug, Error)]
pub enum ClientError {
    /// The relay URL is not `ws` or `wss`.
    #[error("huddle relay url is invalid")]
    Url,
    /// The socket failed before the room admitted this key.
    #[error("huddle connection failed: {0}")]
    Connect(String),
    /// Auth event construction failed.
    #[error("huddle auth failed: {0}")]
    Auth(String),
    /// The relay rejected the socket.
    #[error("huddle relay error: {0}")]
    Rejected(String),
}

impl From<buzz_ws_client::WsClientError> for ClientError {
    fn from(error: buzz_ws_client::WsClientError) -> Self {
        Self::Auth(error.to_string())
    }
}
