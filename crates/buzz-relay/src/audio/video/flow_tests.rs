//! Production-seam tests for layer selection, caps, and room removal.

use super::header::FLAG_KEYFRAME;
use super::hub::VideoHub;
use super::types::{VideoCtrl, QUEUE_FRAMES, VIDEO_MAX_FRAME_BYTES};

fn frame(track: u8, layer: u8, key: bool, n: u8) -> Vec<u8> {
    vec![
        track,
        layer,
        if key { FLAG_KEYFRAME } else { 0 },
        0,
        0,
        0,
        0,
        n,
        0,
        0,
        0,
        n,
        n,
    ]
}

pub(super) fn publish_camera(hub: &VideoHub, index: u8, epoch: u8, generation: u64) {
    hub.handle_control(
        index,
        epoch,
        generation,
        r#"{"type":"publish","track":0,"codec":"avc1.42E01F","layers":[{"layer":0,"w":320,"h":180,"max_kbps":150},{"layer":1,"w":1280,"h":720,"max_kbps":1200}]}"#,
    );
}

fn texts(rx: &mut tokio::sync::mpsc::Receiver<VideoCtrl>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(VideoCtrl::Text(text)) = rx.try_recv() {
        out.push(text);
    }
    out
}

#[test]
fn subscriber_receives_the_selected_layer_prefixed_with_epoch() {
    let hub = VideoHub::new();
    let a = hub.bind(1, 4, "a".into());
    let mut b = hub.bind(2, 0, "b".into());
    publish_camera(&hub, 1, 4, a.generation);
    hub.handle_control(
        2,
        0,
        b.generation,
        r#"{"type":"subscribe","peer_index":1,"epoch":4,"track":0,"layer":0}"#,
    );
    hub.push_frame(1, 4, a.generation, &frame(0, 1, true, 1));
    assert!(b.media_rx.try_recv().is_err());
    hub.push_frame(1, 4, a.generation, &frame(0, 0, false, 2));
    assert!(b.media_rx.try_recv().is_err());
    let client = frame(0, 0, true, 3);
    hub.push_frame(1, 4, a.generation, &client);
    let got = b.media_rx.try_recv().expect("keyframe");
    assert_eq!(&got[..2], &[1, 4]);
    assert_eq!(&got[2..], client.as_slice());
}

#[test]
fn dropped_frames_wait_for_the_next_keyframe() {
    let hub = VideoHub::new();
    let mut a = hub.bind(1, 0, "a".into());
    let mut b = hub.bind(2, 0, "b".into());
    publish_camera(&hub, 1, 0, a.generation);
    hub.handle_control(
        2,
        0,
        b.generation,
        r#"{"type":"subscribe","peer_index":1,"epoch":0,"track":0,"layer":0}"#,
    );
    let _ = texts(&mut a.ctrl_rx);
    for n in 0..QUEUE_FRAMES {
        hub.push_frame(1, 0, a.generation, &frame(0, 0, true, n as u8));
    }
    hub.push_frame(1, 0, a.generation, &frame(0, 0, true, 99));
    // The subscribe already requested a keyframe inside the 500 ms window,
    // so the overflow must not emit a second request. It still waits.
    let _ = texts(&mut a.ctrl_rx);
    while let Ok(buf) = b.media_rx.try_recv() {
        hub.release(2, 0, b.generation, buf.len());
    }
    hub.push_frame(1, 0, a.generation, &frame(0, 0, false, 7));
    assert!(b.media_rx.try_recv().is_err());
    let mut recovery = frame(0, 0, true, 8);
    recovery.push(0xEE);
    hub.push_frame(1, 0, a.generation, &recovery);
    let got = b.media_rx.try_recv().expect("recovered keyframe");
    assert_eq!(got[got.len() - 1], 0xEE);
}

#[test]
fn keyframe_requests_are_rate_limited_per_layer() {
    let hub = VideoHub::new();
    let mut a = hub.bind(1, 0, "a".into());
    let b = hub.bind(2, 0, "b".into());
    publish_camera(&hub, 1, 0, a.generation);
    let sub = r#"{"type":"subscribe","peer_index":1,"epoch":0,"track":0,"layer":0}"#;
    hub.handle_control(2, 0, b.generation, sub);
    hub.handle_control(2, 0, b.generation, sub);
    let n = texts(&mut a.ctrl_rx)
        .iter()
        .filter(|t| t.contains("keyframe_request"))
        .count();
    assert_eq!(n, 1);
}

#[test]
fn caps_allow_eight_cameras_and_one_screen() {
    let hub = VideoHub::new();
    let screen = r#"{"type":"publish","track":1,"codec":"avc1.42E01F","layers":[{"layer":0,"w":1280,"h":720,"max_kbps":1500}]}"#;
    let mut owner = hub.bind(0, 0, "owner".into());
    publish_camera(&hub, 0, 0, owner.generation);
    hub.handle_control(0, 0, owner.generation, screen);
    let mut held = Vec::new();
    for i in 1..8 {
        let lease = hub.bind(i, 0, format!("p{i}"));
        publish_camera(&hub, i, 0, lease.generation);
        held.push(lease);
    }
    assert_eq!(held.len(), 7);
    let mut ninth = hub.bind(8, 0, "ninth".into());
    publish_camera(&hub, 8, 0, ninth.generation);
    assert!(texts(&mut ninth.ctrl_rx)
        .iter()
        .any(|t| t.contains("camera_limit")));
    let mut other = hub.bind(1, 1, "other".into());
    hub.handle_control(1, 1, other.generation, screen);
    assert!(texts(&mut other.ctrl_rx)
        .iter()
        .any(|t| t.contains("screen_share_busy")));
    let _ = texts(&mut owner.ctrl_rx);
    hub.handle_control(0, 0, owner.generation, screen);
    assert!(!texts(&mut owner.ctrl_rx)
        .iter()
        .any(|t| t.contains("screen_share_busy")));
}

#[test]
fn oversize_frame_asks_the_publisher_to_shrink() {
    let hub = VideoHub::new();
    let mut a = hub.bind(1, 0, "a".into());
    let mut big = vec![0u8; VIDEO_MAX_FRAME_BYTES + 1];
    big[0] = 0;
    big[1] = 1;
    hub.note_oversize(1, 0, a.generation, &big);
    assert!(texts(&mut a.ctrl_rx)
        .iter()
        .any(|t| t.contains("frame_too_large")));
}
