//! Send and receive loops for one bound video socket.

use axum::extract::ws::{Message as WsMessage, WebSocket};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::audio::room::Room;

use super::header::{classify_inbound, InboundFrame};
use super::types::VideoCtrl;

pub(super) struct PumpSockets<'a> {
    pub sink: &'a mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    pub stream: &'a mut futures_util::stream::SplitStream<WebSocket>,
    pub media_rx: mpsc::Receiver<Bytes>,
    pub ctrl_rx: mpsc::Receiver<VideoCtrl>,
    pub term_rx: &'a mut mpsc::Receiver<WsMessage>,
    pub cancel: &'a CancellationToken,
}

pub(super) async fn pump(
    room: &Room,
    index: u8,
    epoch: u8,
    generation: u64,
    io: PumpSockets<'_>,
) {
    let PumpSockets {
        sink,
        stream,
        mut media_rx,
        mut ctrl_rx,
        term_rx,
        cancel,
    } = io;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            frame = term_rx.recv() => {
                if let Some(frame) = frame {
                    let _ = sink.send(frame).await;
                }
                break;
            }
            ctrl = ctrl_rx.recv() => match ctrl {
                Some(VideoCtrl::Text(text)) => {
                    if sink.send(WsMessage::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Some(VideoCtrl::Close) | None => break,
            },
            media = media_rx.recv() => {
                let Some(frame) = media else { break };
                let len = frame.len();
                if sink.send(WsMessage::Binary(frame)).await.is_err() {
                    break;
                }
                room.video.release(index, epoch, generation, len);
            }
            incoming = stream.next() => {
                if !on_client(room, index, epoch, generation, incoming) {
                    break;
                }
            }
        }
    }
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
