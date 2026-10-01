//! The video route parser cap is 512 KB, separate from the 8 KB audio cap.

use std::sync::Arc;
use std::time::Duration;

use axum::{routing::get, Router};
use futures_util::SinkExt;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::limit_video_websocket;
use super::types::VIDEO_MAX_FRAME_BYTES;

async fn handler_receives_message_of_size(size: usize) -> bool {
    let (received_tx, received_rx) = oneshot::channel();
    let received_tx = Arc::new(Mutex::new(Some(received_tx)));
    let app = Router::new().route(
        "/",
        get({
            let received_tx = Arc::clone(&received_tx);
            move |ws: axum::extract::WebSocketUpgrade| {
                let received_tx = Arc::clone(&received_tx);
                async move {
                    limit_video_websocket(ws).on_upgrade(move |mut socket| async move {
                        let received = matches!(socket.recv().await, Some(Ok(_)));
                        if let Some(tx) = received_tx.lock().await.take() {
                            let _ = tx.send(received);
                        }
                    })
                }
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    let (mut client, _) = connect_async(format!("ws://{addr}/"))
        .await
        .expect("connect");
    if client
        .send(Message::Text("x".repeat(size).into()))
        .await
        .is_err()
    {
        server.abort();
        return false;
    }
    let received = tokio::time::timeout(Duration::from_secs(2), received_rx)
        .await
        .expect("timeout")
        .expect("result");
    server.abort();
    received
}

#[tokio::test]
async fn video_websocket_parser_rejects_frames_above_512_kib() {
    assert!(handler_receives_message_of_size(VIDEO_MAX_FRAME_BYTES).await);
    assert!(!handler_receives_message_of_size(VIDEO_MAX_FRAME_BYTES + 1).await);
}
