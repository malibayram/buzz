//! A slow viewer must degrade alone: it drops to the low camera layer instead
//! of re-arming the high layer for every viewer, and its queue stays bounded.

use super::flow_tests::{frame, publish_camera, texts};
use super::header::FLAG_KEYFRAME;
use super::hub::VideoHub;
use super::types::{QUEUE_BYTES, QUEUE_FRAMES, VIDEO_MAX_FRAME_BYTES};

const SUB_HIGH: &str = r#"{"type":"subscribe","peer_index":1,"epoch":0,"track":0,"layer":1}"#;

#[test]
fn overflow_on_the_high_layer_downgrades_only_the_slow_viewer() {
    let hub = VideoHub::new();
    let mut publisher = hub.bind(1, 0, "a".into());
    let mut slow = hub.bind(2, 0, "slow".into());
    let mut fast = hub.bind(3, 0, "fast".into());
    publish_camera(&hub, 1, 0, publisher.generation);
    hub.handle_control(2, 0, slow.generation, SUB_HIGH);
    hub.handle_control(3, 0, fast.generation, SUB_HIGH);
    for n in 0..QUEUE_FRAMES {
        hub.push_frame(1, 0, publisher.generation, &frame(0, 1, true, n as u8));
        // The fast viewer drains as frames arrive.
        while let Ok(buf) = fast.media_rx.try_recv() {
            hub.release(3, 0, fast.generation, buf.len());
        }
    }
    let _ = texts(&mut publisher.ctrl_rx);
    // The slow viewer's queue is full: this frame overflows it.
    hub.push_frame(1, 0, publisher.generation, &frame(0, 1, false, 200));
    assert!(
        texts(&mut publisher.ctrl_rx)
            .iter()
            .any(|t| t.contains("keyframe_request") && t.contains("\"layer\":0")),
        "the downgrade must ask for a low-layer keyframe"
    );
    while let Ok(buf) = slow.media_rx.try_recv() {
        hub.release(2, 0, slow.generation, buf.len());
    }
    while let Ok(buf) = fast.media_rx.try_recv() {
        hub.release(3, 0, fast.generation, buf.len());
    }

    hub.push_frame(1, 0, publisher.generation, &frame(0, 1, true, 201));
    assert!(
        slow.media_rx.try_recv().is_err(),
        "slow viewer left layer 1"
    );
    let got = fast.media_rx.try_recv().expect("fast viewer keeps layer 1");
    assert_eq!(got[3], 1);

    hub.push_frame(1, 0, publisher.generation, &frame(0, 0, false, 202));
    assert!(slow.media_rx.try_recv().is_err(), "waits for a keyframe");
    hub.push_frame(1, 0, publisher.generation, &frame(0, 0, true, 203));
    let got = slow.media_rx.try_recv().expect("low-layer keyframe");
    assert_eq!((got[3], got[4] & FLAG_KEYFRAME), (0, FLAG_KEYFRAME));
}

#[test]
fn a_maximal_keyframe_fits_an_empty_queue() {
    // Relay prefix adds two bytes to the largest client frame.
    const { assert!(QUEUE_BYTES >= VIDEO_MAX_FRAME_BYTES + 2) };
    let hub = VideoHub::new();
    let publisher = hub.bind(1, 0, "a".into());
    let mut viewer = hub.bind(2, 0, "b".into());
    publish_camera(&hub, 1, 0, publisher.generation);
    hub.handle_control(2, 0, viewer.generation, SUB_HIGH);
    let mut big = frame(0, 1, true, 1);
    big.resize(VIDEO_MAX_FRAME_BYTES, 0xAB);
    hub.push_frame(1, 0, publisher.generation, &big);
    let got = viewer
        .media_rx
        .try_recv()
        .expect("max-size keyframe admitted");
    assert_eq!(got.len(), VIDEO_MAX_FRAME_BYTES + 2);
}
