//! Occupancy map from huddle control messages.

use std::collections::HashMap;

use serde_json::Value;

/// Record the occupants in a `joined` message, or drop one on `left`.
pub fn apply_roster(peers: &mut HashMap<(u8, u8), String>, value: &Value) {
    match value.get("type").and_then(|kind| kind.as_str()) {
        Some("joined") => {
            remember(peers, value);
            if let Some(list) = value.get("peers").and_then(|peers| peers.as_array()) {
                for peer in list {
                    remember(peers, peer);
                }
            }
        }
        Some("left") => {
            if let Some(key) = occupant_key(value) {
                peers.remove(&key);
            }
        }
        _ => {}
    }
}

fn remember(peers: &mut HashMap<(u8, u8), String>, value: &Value) {
    let Some(key) = occupant_key(value) else {
        return;
    };
    let Some(pubkey) = value.get("pubkey").and_then(|pubkey| pubkey.as_str()) else {
        return;
    };
    if pubkey.is_empty() {
        return;
    }
    peers.insert(key, pubkey.to_string());
}

fn occupant_key(value: &Value) -> Option<(u8, u8)> {
    let index = u8::try_from(value.get("peer_index")?.as_u64()?).ok()?;
    let epoch = value
        .get("epoch")
        .and_then(|epoch| epoch.as_u64())
        .and_then(|epoch| u8::try_from(epoch).ok())
        .unwrap_or(0);
    Some((index, epoch))
}
