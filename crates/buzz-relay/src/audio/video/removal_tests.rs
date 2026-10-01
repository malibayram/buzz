//! Each audio removal path must drop video tracks. Removing one clear fails.

use super::flow_tests::publish_camera;
use super::types::VideoCtrl;
use crate::audio::room::Room;
use buzz_core::CommunityId;
use uuid::Uuid;

fn room() -> Room {
    Room::new(CommunityId::from_uuid(Uuid::new_v4()), Uuid::new_v4())
}

fn closed(rx: &mut tokio::sync::mpsc::Receiver<VideoCtrl>) -> bool {
    let mut saw_close = false;
    while let Ok(msg) = rx.try_recv() {
        saw_close |= matches!(msg, VideoCtrl::Close);
    }
    saw_close
}

#[test]
fn committed_leave_removes_the_track() {
    let room = room();
    let (id, index, epoch, _, _, _) = room.add_peer("a".into(), 4).unwrap();
    room.mark_committed(id);
    let mut live = room.video.bind(index, epoch, "a".into());
    publish_camera(&room.video, index, epoch, live.generation);
    let mut watcher = room.video.bind(9, 0, "w".into());
    room.remove_peer_and_check_ended(id).unwrap();
    assert!(closed(&mut live.ctrl_rx));
    let mut saw = false;
    while let Ok(VideoCtrl::Text(text)) = watcher.ctrl_rx.try_recv() {
        saw |= text.contains("track_delta") && text.contains("\"tracks\":[]");
    }
    assert!(saw, "watcher must see the track removed");
}

#[test]
fn silent_pending_removal_clears_video() {
    let room = room();
    let (id, index, epoch, _, _, _) = room.add_peer_pending("p".into(), 4).unwrap();
    let mut silent = room.video.bind(index, epoch, "p".into());
    assert!(room.remove_peer_silent(id));
    assert!(closed(&mut silent.ctrl_rx));
}

#[test]
fn ingress_remove_peer_clears_video() {
    let room = room();
    let (id, epoch, _, _, _) = room.add_peer_at_index("a".into(), 4, 5).unwrap();
    let mut live = room.video.bind(5, epoch, "a".into());
    room.remove_peer(id).unwrap();
    assert!(closed(&mut live.ctrl_rx));
}

#[test]
fn epoch_reuse_clears_the_stale_occupant() {
    let room = room();
    let (id, _, _, _, _) = room.add_peer_at_index("a".into(), 4, 5).unwrap();
    room.remove_peer(id).unwrap();
    let mut stale = room.video.bind(5, 0, "stale".into());
    let (_, epoch, _, _, _) = room.add_peer_at_index("b".into(), 4, 5).unwrap();
    assert_ne!(epoch, 0);
    assert!(closed(&mut stale.ctrl_rx));
}

#[test]
fn pending_room_end_and_mark_ended_clear_video() {
    let room = room();
    let (id, index, epoch, _, _, _) = room.add_peer_pending("p".into(), 4).unwrap();
    let mut pending = room.video.bind(index, epoch, "p".into());
    assert!(room.remove_peer_silent_and_check_ended(id).0);
    assert!(closed(&mut pending.ctrl_rx));

    let mut ended = room.video.bind(4, 3, "end".into());
    assert!(room.mark_ended());
    assert!(closed(&mut ended.ctrl_rx));
}

#[test]
fn unpublish_and_unbind_emit_an_empty_track_delta() {
    let room = room();
    let hub = &room.video;
    let mut publisher = hub.bind(1, 0, "a".into());
    publish_camera(hub, 1, 0, publisher.generation);
    let mut watcher = hub.bind(2, 0, "w".into());
    while watcher.ctrl_rx.try_recv().is_ok() {}
    hub.handle_control(
        1,
        0,
        publisher.generation,
        r#"{"type":"unpublish","track":0}"#,
    );
    let mut saw = false;
    while let Ok(VideoCtrl::Text(text)) = watcher.ctrl_rx.try_recv() {
        saw |= text.contains("\"tracks\":[]");
    }
    assert!(saw);
    hub.unbind(1, 0, publisher.generation);
    assert!(closed(&mut publisher.ctrl_rx));
}
