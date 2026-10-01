//! Text control messages on the video socket.

use super::types::{LayerDesc, TrackDesc, CODEC_AVC, TRACK_CAMERA, TRACK_SCREEN};

#[derive(Debug)]
pub enum ClientControl {
    Publish {
        track: u8,
        codec: String,
        layers: Vec<LayerDesc>,
    },
    Unpublish {
        track: u8,
    },
    Subscribe {
        peer_index: u8,
        epoch: u8,
        track: u8,
        layer: Option<u8>,
    },
}

pub fn parse_client(text: &str) -> Result<ClientControl, &'static str> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "bad_control")?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("publish") => parse_publish(&v),
        Some("unpublish") => Ok(ClientControl::Unpublish {
            track: req_u8(&v, "track")?,
        }),
        Some("subscribe") => Ok(ClientControl::Subscribe {
            peer_index: req_u8(&v, "peer_index")?,
            epoch: req_u8(&v, "epoch")?,
            track: req_u8(&v, "track")?,
            layer: opt_u8(&v, "layer")?,
        }),
        _ => Err("bad_control"),
    }
}

fn parse_publish(v: &serde_json::Value) -> Result<ClientControl, &'static str> {
    let track = req_u8(v, "track")?;
    let codec = v
        .get("codec")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    if codec != CODEC_AVC {
        return Err("unsupported_codec");
    }
    let layers = v
        .get("layers")
        .and_then(|l| l.as_array())
        .ok_or("invalid_publish")?;
    if layers.is_empty() {
        return Err("invalid_publish");
    }
    let mut out = Vec::with_capacity(layers.len());
    for layer in layers {
        let id = req_u8(layer, "layer")?;
        let width = req_u16(layer, "w")?;
        let height = req_u16(layer, "h")?;
        let max_kbps = req_u32(layer, "max_kbps")?;
        if width == 0 || height == 0 || !layer_ok(track, id) {
            return Err("invalid_publish");
        }
        out.push(LayerDesc {
            layer: id,
            width,
            height,
            max_kbps,
        });
    }
    Ok(ClientControl::Publish {
        track,
        codec,
        layers: out,
    })
}

fn layer_ok(track: u8, layer: u8) -> bool {
    match track {
        TRACK_CAMERA => layer <= 1,
        TRACK_SCREEN => layer == 0,
        _ => false,
    }
}

fn req_u8(v: &serde_json::Value, key: &str) -> Result<u8, &'static str> {
    v.get(key)
        .and_then(|n| n.as_u64())
        .and_then(|n| u8::try_from(n).ok())
        .ok_or("bad_control")
}

fn opt_u8(v: &serde_json::Value, key: &str) -> Result<Option<u8>, &'static str> {
    match v.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(_) => req_u8(v, key).map(Some),
    }
}

fn req_u16(v: &serde_json::Value, key: &str) -> Result<u16, &'static str> {
    v.get(key)
        .and_then(|n| n.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or("invalid_publish")
}

fn req_u32(v: &serde_json::Value, key: &str) -> Result<u32, &'static str> {
    v.get(key)
        .and_then(|n| n.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("invalid_publish")
}

pub fn error_msg(code: &str) -> String {
    serde_json::json!({"type":"error","code":code}).to_string()
}

pub fn error_frame(code: &str, track: u8, layer: u8) -> String {
    serde_json::json!({"type":"error","code":code,"track":track,"layer":layer}).to_string()
}

pub fn keyframe_request(track: u8, layer: u8) -> String {
    serde_json::json!({"type":"keyframe_request","track":track,"layer":layer}).to_string()
}

pub fn tracks_json(revision: u64, peers: Vec<serde_json::Value>) -> String {
    serde_json::json!({"type":"tracks","revision":revision,"peers":peers}).to_string()
}

pub fn peer_json(index: u8, epoch: u8, pubkey: &str, tracks: &[TrackDesc]) -> serde_json::Value {
    serde_json::json!({
        "peer_index": index,
        "epoch": epoch,
        "pubkey": pubkey,
        "tracks": tracks_body(tracks),
    })
}

pub fn delta_json(
    revision: u64,
    index: u8,
    epoch: u8,
    pubkey: &str,
    tracks: &[TrackDesc],
) -> String {
    serde_json::json!({
        "type": "track_delta",
        "revision": revision,
        "peer_index": index,
        "epoch": epoch,
        "pubkey": pubkey,
        "tracks": tracks_body(tracks),
    })
    .to_string()
}

fn tracks_body(tracks: &[TrackDesc]) -> Vec<serde_json::Value> {
    tracks
        .iter()
        .map(|t| {
            serde_json::json!({
                "track": t.track,
                "codec": t.codec,
                "layers": t.layers.iter().map(|l| serde_json::json!({
                    "layer": l.layer, "w": l.width, "h": l.height, "max_kbps": l.max_kbps,
                })).collect::<Vec<_>>(),
            })
        })
        .collect()
}
