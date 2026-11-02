use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::accept_async;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsStatus {
    pub listening: bool,
    pub port: u16,
    pub peer_connected: bool,
    pub peer_addr: Option<String>,
}

type Outbound = mpsc::UnboundedSender<String>;

pub struct WsHub {
    port: u16,
    outbound: Mutex<Option<Outbound>>,
    peer_addr: Mutex<Option<String>>,
    listening: Mutex<bool>,
}

impl WsHub {
    pub fn new(port: u16) -> Arc<Self> {
        Arc::new(Self {
            port,
            outbound: Mutex::new(None),
            peer_addr: Mutex::new(None),
            listening: Mutex::new(false),
        })
    }

    pub fn status(&self) -> WsStatus {
        WsStatus {
            listening: *self.listening.lock(),
            port: self.port,
            peer_connected: self.outbound.lock().is_some(),
            peer_addr: self.peer_addr.lock().clone(),
        }
    }

    pub fn send_to_peer(&self, text: String) -> Result<(), String> {
        let guard = self.outbound.lock();
        let tx = guard.as_ref().ok_or_else(|| "no peer connected".to_string())?;
        tx.send(text).map_err(|e| e.to_string())
    }
}

pub async fn start_listener(app: AppHandle, hub: Arc<WsHub>) -> Result<(), String> {
    let addr = SocketAddr::from(([0, 0, 0, 0], hub.port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    *hub.listening.lock() = true;
    let _ = app.emit("ws-status", hub.status());

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };
        // Single peer for v0.1 — drop previous if any.
        handle_connection(app.clone(), hub.clone(), stream, peer).await;
    }
}

async fn handle_connection(
    app: AppHandle,
    hub: Arc<WsHub>,
    stream: TcpStream,
    peer: SocketAddr,
) {
    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("ws handshake failed from {peer}: {e}");
            return;
        }
    };

    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *hub.outbound.lock() = Some(tx);
    *hub.peer_addr.lock() = Some(peer.to_string());
    let _ = app.emit("ws-status", hub.status());
    let _ = app.emit(
        "ws-peer",
        serde_json::json!({ "connected": true, "addr": peer.to_string() }),
    );

    let writer = async {
        while let Some(msg) = rx.recv().await {
            if write.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    };

    let reader = async {
        while let Some(Ok(msg)) = read.next().await {
            match msg {
                Message::Text(text) => {
                    let _ = app.emit("ws-message", text.to_string());
                }
                Message::Binary(bin) => {
                    if let Ok(text) = String::from_utf8(bin.to_vec()) {
                        let _ = app.emit("ws-message", text);
                    }
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
    };

    tokio::select! {
        _ = writer => {},
        _ = reader => {},
    }

    *hub.outbound.lock() = None;
    *hub.peer_addr.lock() = None;
    let _ = app.emit("ws-status", hub.status());
    let _ = app.emit("ws-peer", serde_json::json!({ "connected": false }));
}
