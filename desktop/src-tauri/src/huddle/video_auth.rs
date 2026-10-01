//! Video-socket auth. The private key stays in Rust; the WebView owns the socket.

use tauri::State;

use crate::app_state::AppState;

#[tauri::command]
pub fn set_huddle_video_enabled(_enabled: bool) {}

#[derive(serde::Serialize)]
pub struct HuddleVideoInfo {
    pub url: String,
    pub relay_url: String,
    pub parent_channel_id: String,
}

#[tauri::command]
pub fn huddle_video_info(state: State<'_, AppState>) -> Result<HuddleVideoInfo, String> {
    let relay_url = crate::relay::relay_ws_url_with_override(&state);
    let hs = state.huddle()?;
    let channel = hs
        .ephemeral_channel_id
        .clone()
        .ok_or_else(|| "no active huddle".to_string())?;
    let parent = hs
        .parent_channel_id
        .clone()
        .ok_or_else(|| "no parent channel".to_string())?;
    Ok(HuddleVideoInfo {
        url: format!("{relay_url}/huddle/{channel}/video"),
        relay_url,
        parent_channel_id: parent,
    })
}

#[tauri::command]
pub fn sign_huddle_video_auth(
    challenge: String,
    relay_url: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use nostr::JsonUtil;
    let keys = state.keys.lock().map_err(|err| err.to_string())?.clone();
    let event =
        super::relay_api::build_audio_auth_event(&keys, &relay_url, &challenge, None)?;
    serde_json::from_str(&event.as_json()).map_err(|err| format!("serialize auth event: {err}"))
}
