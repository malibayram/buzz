//! Shared pre-upgrade gates for huddle audio and video sockets.

use std::sync::Arc;

use axum::extract::{FromRequest, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use buzz_auth::VerifiedAssertion;
use buzz_core::tenant::TenantContext;
use chrono::{DateTime, Utc};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::warn;
use uuid::Uuid;

use crate::state::AppState;

/// Gates shared by the huddle audio and video WebSocket upgrades.
pub struct HuddleUpgrade {
    /// Community resolved from the request host.
    pub tenant: TenantContext,
    /// Present when NIP-FI admission produced an assertion.
    pub nip_fi_assertion: Option<VerifiedAssertion>,
    /// When the upgrade was accepted.
    pub connection_time: DateTime<Utc>,
    /// Counts against the process-wide connection cap.
    pub permit: OwnedSemaphorePermit,
    /// The WebSocket upgrade, still unbounded by the route's frame cap.
    pub ws: WebSocketUpgrade,
}

/// Run NIP-FI, community binding, and the connection cap, then build the upgrade.
pub async fn prepare_huddle_upgrade(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    req: axum::extract::Request,
    channel_id: Uuid,
    route: &str,
) -> Result<HuddleUpgrade, Response> {
    let nip_fi_assertion = {
        use crate::nip_fi_upgrade::{check_nip_fi_at_upgrade, NipFiUpgradeOutcome};
        match check_nip_fi_at_upgrade(
            headers,
            state.nip_fi_verifier.as_deref(),
            state.config.nip_fi.mode,
        ) {
            NipFiUpgradeOutcome::NotRequired => None,
            NipFiUpgradeOutcome::Admitted(assertion) => Some(assertion),
            NipFiUpgradeOutcome::Denied(resp) => return Err(resp.into_response()),
        }
    };
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = match crate::tenant::bind_community(&state.db, raw_host).await {
        Ok(ctx) => ctx,
        Err(_) => {
            return Err((
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
                .into_response());
        }
    };
    let ws = match WebSocketUpgrade::from_request(req, state).await {
        Ok(ws) => ws,
        Err(resp) => return Err(resp.into_response()),
    };
    let Some(permit) = acquire_huddle_connection_permit(&state.conn_semaphore) else {
        warn!(%channel_id, route, "connection limit reached, rejecting huddle websocket");
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "relay: connection limit reached",
        )
            .into_response());
    };
    Ok(HuddleUpgrade {
        tenant,
        nip_fi_assertion,
        connection_time: Utc::now(),
        permit,
        ws,
    })
}

pub(crate) fn acquire_huddle_connection_permit(
    conn_semaphore: &Arc<Semaphore>,
) -> Option<OwnedSemaphorePermit> {
    Arc::clone(conn_semaphore).try_acquire_owned().ok()
}
