//! Huddle video WebSocket. Binds to a committed audio peer and forwards frames.

mod cast;
mod forward;
mod header;
mod hub;
mod msgs;
mod ops;
mod pump;
mod session;
mod types;

#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod limit_test;
#[cfg(test)]
mod removal_tests;

use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use uuid::Uuid;

use crate::state::AppState;

pub use hub::VideoHub;

/// Cap a video socket at one 512 KB access unit. Audio stays on its own limit.
pub fn limit_video_websocket<F>(ws: WebSocketUpgrade<F>) -> WebSocketUpgrade<F> {
    ws.max_message_size(types::VIDEO_MAX_FRAME_BYTES)
        .max_frame_size(types::VIDEO_MAX_FRAME_BYTES)
}

/// `GET /huddle/{channel_id}/video`. Binds only to a committed audio peer.
pub async fn ws_video_handler(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<Uuid>,
    headers: HeaderMap,
    req: axum::extract::Request,
) -> impl IntoResponse {
    let prepared =
        match super::upgrade::prepare_huddle_upgrade(&state, &headers, req, channel_id, "video")
            .await
        {
            Ok(prepared) => prepared,
            Err(resp) => return resp,
        };
    let super::upgrade::HuddleUpgrade {
        tenant,
        nip_fi_assertion,
        connection_time,
        permit,
        ws,
    } = prepared;
    limit_video_websocket(ws).on_upgrade(move |socket| {
        session::run_video_connection(
            socket,
            state,
            tenant,
            channel_id,
            permit,
            nip_fi_assertion,
            connection_time,
        )
    })
}
