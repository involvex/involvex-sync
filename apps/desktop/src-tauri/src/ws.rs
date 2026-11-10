use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::accept_async;

/// How often each connection is pinged and how long silence is tolerated.
/// Phones drop off Wi-Fi without closing the socket, so this is the only
/// thing that reaps dead peers.
const HEARTBEAT: Duration = Duration::from_secs(15);
const PEER_TIMEOUT: Duration = Duration::from_secs(75);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsStatus {
    pub listening: bool,
    pub port: u16,
    pub peer_connected: bool,
    pub peer_addr: Option<String>,
    /// Number of live sockets (LAN peers + anything else that connected).
    pub conn_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    pub conn_id: u32,
    pub addr: String,
}

/// Messages the writer task pushes into the socket.
#[derive(Debug)]
enum WsOut {
    Text(String),
    Ping,
    Pong(Vec<u8>),
    Close,
}

type Outbound = mpsc::UnboundedSender<WsOut>;

struct Conn {
    tx: Outbound,
    addr: String,
}

pub struct WsHub {
    port: u16,
    /// Every live connection. Keyed by id so frames can be targeted.
    conns: Mutex<HashMap<u32, Conn>>,
    /// Connection that legacy `ws_send` addresses (latest one wins).
    active: Mutex<Option<u32>>,
    listening: Mutex<bool>,
    next_id: AtomicU32,
}

impl WsHub {
    pub fn new(port: u16) -> Arc<Self> {
        Arc::new(Self {
            port,
            conns: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            listening: Mutex::new(false),
            next_id: AtomicU32::new(1),
        })
    }

    fn alloc_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn status(&self) -> WsStatus {
        let conns = self.conns.lock();
        let active = *self.active.lock();
        let peer_addr = active
            .and_then(|id| conns.get(&id).map(|c| c.addr.clone()))
            .or_else(|| conns.values().next().map(|c| c.addr.clone()));
        WsStatus {
            listening: *self.listening.lock(),
            port: self.port,
            peer_connected: !conns.is_empty(),
            peer_addr,
            conn_count: conns.len(),
        }
    }

    pub fn conn_list(&self) -> Vec<ConnInfo> {
        let mut list: Vec<ConnInfo> = self
            .conns
            .lock()
            .iter()
            .map(|(id, c)| ConnInfo {
                conn_id: *id,
                addr: c.addr.clone(),
            })
            .collect();
        list.sort_by_key(|c| c.conn_id);
        list
    }

    /// Legacy single-peer send: the active connection, or the only one.
    pub fn send_to_peer(&self, text: String) -> Result<(), String> {
        let conns = self.conns.lock();
        let id = self.resolve_active(&conns)?;
        self.send_locked(&conns, id, text)
    }

    /// Targeted send — used when several peers are paired.
    pub fn send_to_conn(&self, conn_id: u32, text: String) -> Result<(), String> {
        let conns = self.conns.lock();
        if !conns.contains_key(&conn_id) {
            return Err(format!("connection {conn_id} is gone"));
        }
        self.send_locked(&conns, conn_id, text)
    }

    /// Drop one peer (e.g. replaced by a reconnect or kicked from the UI).
    pub fn close_conn(&self, conn_id: u32) {
        let _ = self
            .conns
            .lock()
            .remove(&conn_id)
            .map(|c| c.tx.send(WsOut::Close));
        if *self.active.lock() == Some(conn_id) {
            *self.active.lock() = None;
        }
    }

    fn resolve_active(&self, conns: &HashMap<u32, Conn>) -> Result<u32, String> {
        if let Some(id) = *self.active.lock() {
            if conns.contains_key(&id) {
                return Ok(id);
            }
        }
        if conns.len() == 1 {
            return Ok(*conns.keys().next().expect("len == 1"));
        }
        if conns.is_empty() {
            return Err("no peer connected".to_string());
        }
        Err(format!(
            "{} peers connected — target a connection id",
            conns.len()
        ))
    }

    fn send_locked(
        &self,
        conns: &HashMap<u32, Conn>,
        id: u32,
        text: String,
    ) -> Result<(), String> {
        let conn = conns.get(&id).ok_or_else(|| "peer gone".to_string())?;
        conn.tx
            .send(WsOut::Text(text))
            .map_err(|e| e.to_string())
    }

    fn emit_status(&self, app: &AppHandle) {
        let _ = app.emit("ws-status", self.status());
    }
}

/// Payload of the `ws-message` event: the raw frame plus the socket it
/// arrived on, so replies (pair accept/reject) can go back the same way.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsFrameEvent {
    conn_id: u32,
    message: String,
}

pub async fn start_listener(app: AppHandle, hub: Arc<WsHub>) -> Result<(), String> {
    let addr = SocketAddr::from(([0, 0, 0, 0], hub.port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    *hub.listening.lock() = true;
    hub.emit_status(&app);

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };
        // One task per socket: a stalled peer must never block the accept
        // loop (that used to freeze every other connection behind it).
        let app = app.clone();
        let hub = hub.clone();
        tokio::spawn(async move {
            handle_connection(app, hub, stream, peer).await;
        });
    }
}

async fn handle_connection(
    app: AppHandle,
    hub: Arc<WsHub>,
    stream: TcpStream,
    peer: SocketAddr,
) {
    let _ = stream.set_nodelay(true);
    let conn_id = hub.alloc_id();
    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("ws handshake failed from {peer}: {e}");
            return;
        }
    };

    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<WsOut>();
    let seen = Arc::new(Mutex::new(Instant::now()));
    hub.conns.lock().insert(
        conn_id,
        Conn {
            tx: tx.clone(),
            addr: peer.to_string(),
        },
    );
    *hub.active.lock() = Some(conn_id);
    hub.emit_status(&app);
    let _ = app.emit(
        "ws-peer",
        serde_json::json!({ "connected": true, "addr": peer.to_string(), "connId": conn_id }),
    );

    let writer = async {
        while let Some(msg) = rx.recv().await {
            let frame = match msg {
                WsOut::Text(t) => Message::Text(t.into()),
                WsOut::Ping => Message::Ping(Vec::new().into()),
                WsOut::Pong(p) => Message::Pong(p.into()),
                WsOut::Close => {
                    let _ = write.send(Message::Close(None)).await;
                    break;
                }
            };
            if write.send(frame).await.is_err() {
                break;
            }
        }
    };

    let reader = async {
        while let Some(Ok(msg)) = read.next().await {
            *seen.lock() = Instant::now();
            match msg {
                Message::Text(text) => {
                    let _ = app.emit(
                        "ws-message",
                        WsFrameEvent {
                            conn_id,
                            message: text.to_string(),
                        },
                    );
                }
                Message::Binary(bin) => {
                    if let Ok(text) = String::from_utf8(bin.to_vec()) {
                        let _ = app.emit(
                            "ws-message",
                            WsFrameEvent {
                                conn_id,
                                message: text,
                            },
                        );
                    }
                }
                // tungstenite never answers pings for us; without this the
                // peer's keepalive logic would consider us dead.
                Message::Ping(payload) => {
                    if tx.send(WsOut::Pong(payload.to_vec())).is_err() {
                        break;
                    }
                }
                Message::Pong(_) => {}
                Message::Close(_) => break,
                Message::Frame(_) => {}
            }
        }
    };

    let hb_tx = tx.clone();
    let hb_seen = seen.clone();
    let heartbeat = async {
        let mut tick = tokio::time::interval(HEARTBEAT);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if hb_seen.lock().elapsed() > PEER_TIMEOUT {
                eprintln!("ws: peer {peer} timed out after silence");
                break;
            }
            if hb_tx.send(WsOut::Ping).is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = writer => {},
        _ = reader => {},
        _ = heartbeat => {},
    }

    hub.conns.lock().remove(&conn_id);
    if *hub.active.lock() == Some(conn_id) {
        *hub.active.lock() = None;
    }
    hub.emit_status(&app);
    let _ = app.emit(
        "ws-peer",
        serde_json::json!({ "connected": false, "connId": conn_id, "addr": peer.to_string() }),
    );
}
