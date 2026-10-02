//! Send and receive loops for one bound video socket.
//!
//! Reading and writing run as independent futures: a viewer whose downlink is
//! slow must never stop the relay from reading that same peer's uploads.

use std::time::Duration;

use axum::extract::ws::Message as WsMessage;
use bytes::Bytes;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::audio::room::Room;

use super::header::{classify_inbound, InboundFrame};
use super::types::VideoCtrl;

/// Keepalive cadence. Proxies such as Cloudflare close WebSockets that carry
/// no traffic for about 100 s, which silently killed idle video sockets.
pub(super) const PING_INTERVAL: Duration = Duration::from_secs(20);
/// Close a socket that has sent nothing (not even a pong) for this long.
pub(super) const READ_IDLE: Duration = Duration::from_secs(60);
/// A single socket write that takes longer than this means the downlink is dead.
pub(super) const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct PumpSockets<'a, S, R> {
    pub sink: &'a mut S,
    pub stream: &'a mut R,
    pub media_rx: mpsc::Receiver<Bytes>,
    pub ctrl_rx: mpsc::Receiver<VideoCtrl>,
    pub term_rx: &'a mut mpsc::Receiver<WsMessage>,
    pub cancel: &'a CancellationToken,
}

pub(super) async fn pump<S, R>(
    room: &Room,
    index: u8,
    epoch: u8,
    generation: u64,
    io: PumpSockets<'_, S, R>,
) where
    S: Sink<WsMessage> + Unpin,
    R: Stream<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    let PumpSockets {
        sink,
        stream,
        media_rx,
        ctrl_rx,
        term_rx,
        cancel,
    } = io;
    let reader = read_loop(room, index, epoch, generation, stream);
    let writer = write_loop(
        room, index, epoch, generation, sink, media_rx, ctrl_rx, term_rx,
    );
    tokio::select! {
        _ = cancel.cancelled() => {}
        _ = reader => {}
        _ = writer => {}
    }
}

async fn read_loop<R>(room: &Room, index: u8, epoch: u8, generation: u64, stream: &mut R)
where
    R: Stream<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    loop {
        let Ok(incoming) = tokio::time::timeout(READ_IDLE, stream.next()).await else {
            return;
        };
        if !on_client(room, index, epoch, generation, incoming) {
            return;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn write_loop<S>(
    room: &Room,
    index: u8,
    epoch: u8,
    generation: u64,
    sink: &mut S,
    mut media_rx: mpsc::Receiver<Bytes>,
    mut ctrl_rx: mpsc::Receiver<VideoCtrl>,
    term_rx: &mut mpsc::Receiver<WsMessage>,
) where
    S: Sink<WsMessage> + Unpin,
{
    let mut ping =
        tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let message = tokio::select! {
            biased;
            frame = term_rx.recv() => {
                if let Some(frame) = frame {
                    let _ = send(sink, frame).await;
                }
                return;
            }
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(VideoCtrl::Text(text)) => Outgoing::Control(WsMessage::Text(text.into())),
                Some(VideoCtrl::Close) | None => return,
            },
            _ = ping.tick() => Outgoing::Control(WsMessage::Ping(Bytes::new())),
            media = media_rx.recv() => match media {
                Some(frame) => Outgoing::Media(frame),
                None => return,
            },
        };
        match message {
            Outgoing::Control(message) => {
                if !send(sink, message).await {
                    return;
                }
            }
            Outgoing::Media(frame) => {
                let len = frame.len();
                let sent = send(sink, WsMessage::Binary(frame)).await;
                room.video.release(index, epoch, generation, len);
                if !sent {
                    return;
                }
            }
        }
    }
}

enum Outgoing {
    Control(WsMessage),
    Media(Bytes),
}

async fn send<S>(sink: &mut S, message: WsMessage) -> bool
where
    S: Sink<WsMessage> + Unpin,
{
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, sink.send(message)).await,
        Ok(Ok(()))
    )
}

fn on_client(
    room: &Room,
    index: u8,
    epoch: u8,
    generation: u64,
    incoming: Option<Result<WsMessage, axum::Error>>,
) -> bool {
    match incoming {
        Some(Ok(WsMessage::Text(text))) => {
            room.video.handle_control(index, epoch, generation, &text);
            true
        }
        Some(Ok(WsMessage::Binary(bytes))) => {
            match classify_inbound(&bytes) {
                InboundFrame::Oversize => {
                    room.video.note_oversize(index, epoch, generation, &bytes);
                }
                InboundFrame::Media(frame) => {
                    room.video.push_frame(index, epoch, generation, frame);
                }
                InboundFrame::Malformed => {}
            }
            true
        }
        Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) => true,
        _ => false,
    }
}
