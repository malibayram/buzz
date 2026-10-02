//! Socket-loop tests through the production `pump`.

use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::ws::Message as WsMessage;
use buzz_core::CommunityId;
use futures_util::{Sink, Stream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::flow_tests::{frame, publish_camera};
use super::pump::{pump, PumpEnd, PumpSockets, PING_INTERVAL, READ_IDLE};
use crate::audio::room::Room;

type Inbound = Pin<Box<dyn Stream<Item = Result<WsMessage, axum::Error>> + Send>>;

fn inbound() -> (mpsc::UnboundedSender<WsMessage>, Inbound) {
    let (tx, rx) = mpsc::unbounded_channel();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|msg| (Ok(msg), rx))
    });
    (tx, Box::pin(stream))
}

/// A downlink that accepts nothing: every write stays pending.
struct Stalled;

impl Sink<WsMessage> for Stalled {
    type Error = axum::Error;
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Pending
    }
    fn start_send(self: Pin<&mut Self>, _: WsMessage) -> Result<(), Self::Error> {
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Pending
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<WsMessage>>>);

impl Sink<WsMessage> for Recorder {
    type Error = axum::Error;
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn start_send(self: Pin<&mut Self>, item: WsMessage) -> Result<(), Self::Error> {
        if let Ok(mut sent) = self.0.lock() {
            sent.push(item);
        }
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

fn room() -> Room {
    Room::new(CommunityId::from_uuid(Uuid::new_v4()), Uuid::new_v4())
}

#[tokio::test]
async fn a_stalled_downlink_does_not_block_the_peers_uploads() {
    let room = room();
    // Peer 1 publishes and also views peer 2; its downlink is stalled.
    let lease = room.video.bind(1, 0, "a".into());
    let viewer = room.video.bind(2, 0, "b".into());
    let mut viewer_media = viewer.media_rx;
    publish_camera(&room.video, 1, 0, lease.generation);
    publish_camera(&room.video, 2, 0, viewer.generation);
    room.video.handle_control(
        1,
        0,
        lease.generation,
        r#"{"type":"subscribe","peer_index":2,"epoch":0,"track":0,"layer":0}"#,
    );
    room.video.handle_control(
        2,
        0,
        viewer.generation,
        r#"{"type":"subscribe","peer_index":1,"epoch":0,"track":0,"layer":0}"#,
    );
    // Queue media for peer 1 so its writer is stuck mid-send.
    room.video
        .push_frame(2, 0, viewer.generation, &frame(0, 0, true, 1));

    let (uplink, mut stream) = inbound();
    let mut sink = Stalled;
    let (_term_tx, mut term_rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let upload = frame(0, 0, true, 42);
    uplink
        .send(WsMessage::Binary(upload.clone().into()))
        .expect("uplink");

    let run = pump(
        &room,
        1,
        0,
        lease.generation,
        PumpSockets {
            sink: &mut sink,
            stream: &mut stream,
            media_rx: lease.media_rx,
            ctrl_rx: lease.ctrl_rx,
            term_rx: &mut term_rx,
            cancel: &cancel,
        },
    );
    let delivered = async {
        loop {
            if let Ok(got) = viewer_media.try_recv() {
                return got;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::select! {
        _ = run => panic!("pump exited while the downlink was only slow"),
        got = tokio::time::timeout(Duration::from_secs(2), delivered) => {
            let got = got.expect("upload must reach the viewer despite the stalled downlink");
            assert_eq!(&got[2..], upload.as_slice());
        }
    }
}

#[tokio::test(start_paused = true)]
async fn idle_sockets_get_keepalive_pings() {
    let room = room();
    let lease = room.video.bind(1, 0, "a".into());
    let (_uplink, mut stream) = inbound();
    let recorder = Recorder::default();
    let mut sink = recorder.clone();
    let (_term_tx, mut term_rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let run = pump(
        &room,
        1,
        0,
        lease.generation,
        PumpSockets {
            sink: &mut sink,
            stream: &mut stream,
            media_rx: lease.media_rx,
            ctrl_rx: lease.ctrl_rx,
            term_rx: &mut term_rx,
            cancel: &cancel,
        },
    );
    let _ = tokio::time::timeout(PING_INTERVAL + Duration::from_secs(1), run).await;
    let pings = recorder
        .0
        .lock()
        .map(|sent| {
            sent.iter()
                .filter(|m| matches!(m, WsMessage::Ping(_)))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(pings, 1);
}

#[tokio::test(start_paused = true)]
async fn a_silent_client_is_closed_after_the_idle_window() {
    let room = room();
    let lease = room.video.bind(1, 0, "a".into());
    let (_uplink, mut stream) = inbound();
    let mut sink = Recorder::default();
    let (_term_tx, mut term_rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let run = pump(
        &room,
        1,
        0,
        lease.generation,
        PumpSockets {
            sink: &mut sink,
            stream: &mut stream,
            media_rx: lease.media_rx,
            ctrl_rx: lease.ctrl_rx,
            term_rx: &mut term_rx,
            cancel: &cancel,
        },
    );
    let end = tokio::time::timeout(READ_IDLE + Duration::from_secs(1), run)
        .await
        .expect("pump must close a client that never answers");
    assert_eq!(end, PumpEnd::ReadIdle);
}
