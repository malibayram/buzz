//! Video socket session. Admission stays on the audio route; this only binds.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket};
use buzz_auth::{generate_challenge, VerifiedAssertion};
use buzz_core::tenant::TenantContext;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, OwnedSemaphorePermit};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::audio::room::Room;
use crate::state::AppState;

use super::pump::{pump, PumpSockets};
use super::types::REQUIRED_PROTOCOL;

#[derive(Deserialize)]
struct AuthMsg {
    #[serde(rename = "type")]
    msg_type: String,
    event: nostr::Event,
    #[allow(dead_code)]
    parent_channel_id: Option<Uuid>,
    #[serde(default)]
    protocol_version: u8,
}

pub async fn run_video_connection(
    socket: WebSocket,
    state: Arc<AppState>,
    tenant: TenantContext,
    channel_id: Uuid,
    _permit: OwnedSemaphorePermit,
    nip_fi: Option<VerifiedAssertion>,
    connected_at: chrono::DateTime<chrono::Utc>,
) {
    let cancel = CancellationToken::new();
    let (term_tx, mut term_rx) = mpsc::channel(1);
    let deadline = nip_fi.as_ref().map(|a| {
        crate::connection::compute_session_deadline(
            a,
            connected_at,
            state.config.nip_fi.max_connection_lifetime(),
        )
    });
    let gate = Arc::new(match deadline {
        Some(deadline) => crate::nip_fi_gate::SessionAdmissionGate::new(deadline, cancel.clone()),
        None => crate::nip_fi_gate::SessionAdmissionGate::off_mode(cancel.clone()),
    });
    let _expiry = deadline.map(|deadline| {
        crate::nip_fi_session::spawn_nip_fi_expiry_task(
            deadline,
            Arc::clone(&gate),
            term_tx,
            crate::nip_fi_session::NipFiWsRoute::Audio,
        )
    });
    let (mut sink, mut stream) = socket.split();
    if !state.config.huddle_video_available {
        let _ = send_code(&mut sink, "huddle_video_unavailable").await;
        return;
    }
    let challenge = generate_challenge();
    let hello = serde_json::json!({"type":"challenge","challenge":challenge}).to_string();
    if sink.send(WsMessage::Text(hello.into())).await.is_err() {
        return;
    }
    let Some(auth) = read_auth(&mut stream, &cancel).await else {
        tracing::info!(%channel_id, "huddle video socket closed before auth");
        return;
    };
    if auth.msg_type != "auth" {
        return;
    }
    let relay_url = crate::api::bridge::nip42_expected_relay_url(&state.config.relay_url, &tenant);
    let Ok(ctx) = state
        .auth
        .verify_auth_event(auth.event, &challenge, &relay_url)
        .await
    else {
        let _ = send_code(&mut sink, "auth_failed").await;
        return;
    };
    if crate::nip_fi_session::enforce_nip_fi_key_pairing(
        nip_fi.as_ref(),
        ctx.pubkey,
        crate::nip_fi_session::PairingDenialTarget::Audio {
            ws_send: &mut sink,
            cancel: &cancel,
            channel_id,
        },
    )
    .await
        == crate::nip_fi_session::PairingOutcome::Denied
    {
        return;
    }
    if auth.protocol_version != REQUIRED_PROTOCOL {
        let _ = send_code(&mut sink, "unsupported_version").await;
        return;
    }
    if mesh_blocks_video(&state, channel_id) {
        let _ = send_code(&mut sink, "huddle_video_unavailable_on_mesh").await;
        return;
    }
    let Some(room) = state.audio_rooms.get(tenant.community(), channel_id) else {
        let _ = send_code(&mut sink, "video_requires_audio_peer").await;
        return;
    };
    let pubkey = ctx.pubkey.to_hex();
    let Some((index, epoch)) = committed_occupancy(&room, &pubkey) else {
        let _ = send_code(&mut sink, "video_requires_audio_peer").await;
        return;
    };
    let lease = room.video.bind(index, epoch, pubkey);
    if sink
        .send(WsMessage::Text(lease.snapshot.clone().into()))
        .await
        .is_err()
    {
        room.video.unbind(index, epoch, lease.generation);
        return;
    }
    tracing::info!(%channel_id, index, epoch, generation = lease.generation, "huddle video socket bound");
    let end = pump(
        &room,
        index,
        epoch,
        lease.generation,
        PumpSockets {
            sink: &mut sink,
            stream: &mut stream,
            media_rx: lease.media_rx,
            ctrl_rx: lease.ctrl_rx,
            term_rx: &mut term_rx,
            cancel: &cancel,
        },
    )
    .await;
    tracing::info!(%channel_id, index, epoch, generation = lease.generation, reason = ?end, "huddle video socket ended");
    room.video.unbind(index, epoch, lease.generation);
}

fn mesh_blocks_video(state: &AppState, channel_id: Uuid) -> bool {
    state
        .mesh
        .get()
        .is_some_and(|mesh| mesh.owners.lost_for(channel_id).is_none())
}

fn committed_occupancy(room: &Room, pubkey: &str) -> Option<(u8, u8)> {
    room.peers.iter().find_map(|peer| {
        (peer.committed && peer.pubkey == pubkey).then_some((peer.peer_index, peer.epoch))
    })
}

async fn read_auth(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
    cancel: &CancellationToken,
) -> Option<AuthMsg> {
    let wait = async {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return None,
                msg = stream.next() => match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(auth) = serde_json::from_str::<AuthMsg>(&text) {
                            if auth.msg_type == "auth" {
                                return Some(auth);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => return None,
                    _ => continue,
                }
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .ok()
        .flatten()
}

async fn send_code(
    sink: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    code: &str,
) -> Result<(), axum::Error> {
    tracing::info!(code, "huddle video socket rejected");
    let text = super::msgs::error_msg(code);
    sink.send(WsMessage::Text(text.into())).await
}
