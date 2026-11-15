//! Loopback HTTP control plane for the `isync` CLI (127.0.0.1 only).

use crate::ws::WsHub;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::bootlog;

pub const CONTROL_PORT: u16 = 17_392;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSnapshot {
    pub active_peer_id: Option<String>,
    pub peers: Vec<ControlPeer>,
    pub notes: Vec<ControlNote>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPeer {
    pub device_id: String,
    pub name: String,
    pub connected: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlNote {
    pub id: String,
    pub title: String,
    pub body: String,
    pub updated_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusBody {
    ok: bool,
    control: bool,
    peer_connected: bool,
    peer_addr: Option<String>,
    listening: bool,
    lan_port: u16,
    window_visible: bool,
    active_peer_id: Option<String>,
    peer_count: usize,
}

pub fn start(
    app: AppHandle,
    hub: Arc<WsHub>,
    ready: Arc<AtomicBool>,
    snap: Arc<Mutex<ControlSnapshot>>,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = serve(app, hub, ready, snap).await {
            eprintln!("control server failed: {err}");
        }
    });
}

async fn serve(
    app: AppHandle,
    hub: Arc<WsHub>,
    ready: Arc<AtomicBool>,
    snap: Arc<Mutex<ControlSnapshot>>,
) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", CONTROL_PORT))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{CONTROL_PORT}: {e}"))?;
    bootlog::write(&format!(
        "isync control listening on 127.0.0.1:{CONTROL_PORT}"
    ));

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("control accept: {e}");
                continue;
            }
        };
        let app = app.clone();
        let hub = hub.clone();
        let ready = ready.clone();
        let snap = snap.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle(stream, app, hub, ready, snap).await {
                eprintln!("control request: {e}");
            }
        });
    }
}

async fn handle(
    mut stream: TcpStream,
    app: AppHandle,
    hub: Arc<WsHub>,
    ready: Arc<AtomicBool>,
    snap: Arc<Mutex<ControlSnapshot>>,
) -> Result<(), String> {
    let mut buf = vec![0u8; 64 * 1024];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(());
    }
    let raw = String::from_utf8_lossy(&buf[..n]);
    let (method, path, body) = parse_http(&raw)?;

    let (status, ctype, payload) = match (method.as_str(), path.as_str()) {
        ("GET", "/v1/status") | ("GET", "/status") => {
            let ws = hub.status();
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            let snap_guard = snap.lock();
            let body = StatusBody {
                ok: true,
                control: true,
                peer_connected: ws.peer_connected,
                peer_addr: ws.peer_addr,
                listening: ws.listening,
                lan_port: ws.port,
                window_visible: visible,
                active_peer_id: snap_guard.active_peer_id.clone(),
                peer_count: snap_guard.peers.len(),
            };
            (
                200,
                "application/json",
                serde_json::to_string(&body).unwrap_or_else(|_| "{}".into()),
            )
        }
        ("GET", "/v1/peers") => {
            let peers = snap.lock().peers.clone();
            (
                200,
                "application/json",
                serde_json::to_string(&peers).unwrap_or_else(|_| "[]".into()),
            )
        }
        ("POST", "/v1/peer") => {
            let device_id = body.trim().to_string();
            if device_id.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty deviceId"}"#.into(),
                )
            } else {
                let _ = app.emit("isync-peer", device_id);
                (202, "application/json", r#"{"ok":true}"#.into())
            }
        }
        ("GET", "/v1/notes") => {
            let notes = snap.lock().notes.clone();
            (
                200,
                "application/json",
                serde_json::to_string(&notes).unwrap_or_else(|_| "[]".into()),
            )
        }
        ("POST", "/v1/notes") => {
            let payload = body.trim().to_string();
            if payload.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty notes payload"}"#.into(),
                )
            } else {
                // Validate JSON shape lightly; frontend does the upsert.
                match serde_json::from_str::<serde_json::Value>(&payload) {
                    Ok(v) if v.get("title").and_then(|t| t.as_str()).is_some() => {
                        let _ = app.emit("isync-notes", payload);
                        (202, "application/json", r#"{"ok":true}"#.into())
                    }
                    _ => (
                        400,
                        "application/json",
                        r#"{"ok":false,"error":"body must be JSON {title, body?}"}"#.into(),
                    ),
                }
            }
        }
        ("POST", "/v1/file") => {
            let path = body.trim().to_string();
            if path.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty path"}"#.into(),
                )
            } else {
                let _ = app.emit("isync-file", path);
                (202, "application/json", r#"{"ok":true}"#.into())
            }
        }
        ("POST", "/v1/remote") => {
            let payload = body.trim().to_string();
            if payload.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty remote payload"}"#.into(),
                )
            } else {
                match serde_json::from_str::<serde_json::Value>(&payload) {
                    Ok(v) => {
                        let shell = v
                            .get("shell")
                            .and_then(|s| s.as_str())
                            .unwrap_or("");
                        let command = v
                            .get("command")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        if (shell == "termux" || shell == "pwsh") && !command.is_empty()
                        {
                            let _ = app.emit("isync-remote", payload);
                            (202, "application/json", r#"{"ok":true}"#.into())
                        } else {
                            (
                                400,
                                "application/json",
                                r#"{"ok":false,"error":"body must be JSON {shell:\"termux\"|\"pwsh\", command}"}"#.into(),
                            )
                        }
                    }
                    Err(_) => (
                        400,
                        "application/json",
                        r#"{"ok":false,"error":"body must be JSON {shell, command}"}"#.into(),
                    ),
                }
            }
        }
        ("POST", "/v1/show") | ("POST", "/show") => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            (200, "application/json", r#"{"ok":true}"#.into())
        }
        ("POST", "/v1/share") | ("POST", "/share") => {
            let url = body.trim().to_string();
            if url.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty url"}"#.into(),
                )
            } else {
                let _ = app.emit("isync-share", url);
                (202, "application/json", r#"{"ok":true}"#.into())
            }
        }
        ("POST", "/v1/clipboard") | ("POST", "/clipboard") => {
            let text = body.to_string();
            if text.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty clipboard"}"#.into(),
                )
            } else {
                let _ = app.emit("isync-clipboard", text);
                (202, "application/json", r#"{"ok":true}"#.into())
            }
        }
        ("POST", "/v1/find") | ("POST", "/find") => {
            let _ = app.emit("isync-find", true);
            (202, "application/json", r#"{"ok":true}"#.into())
        }
        ("POST", "/v1/keyboard") | ("POST", "/keyboard") => {
            let payload = body.trim().to_string();
            if payload.is_empty() {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"empty keyboard payload"}"#.into(),
                )
            } else {
                let _ = app.emit("isync-keyboard", payload);
                (202, "application/json", r#"{"ok":true}"#.into())
            }
        }
        ("POST", "/v1/screenshot") | ("POST", "/screenshot") => {
            let _ = app.emit("isync-screenshot", true);
            (202, "application/json", r#"{"ok":true}"#.into())
        }
        ("POST", "/v1/mirror") | ("POST", "/mirror") => {
            let action = body.trim().to_ascii_lowercase();
            if action != "start" && action != "stop" {
                (
                    400,
                    "application/json",
                    r#"{"ok":false,"error":"body must be start or stop"}"#.into(),
                )
            } else {
                let _ = app.emit("isync-mirror", action);
                (202, "application/json", r#"{"ok":true}"#.into())
            }
        }
        ("POST", "/v1/escrcpy") | ("POST", "/escrcpy") => {
            let _ = app.emit("isync-escrcpy", true);
            (202, "application/json", r#"{"ok":true}"#.into())
        }
        ("GET", "/v1/ready") => {
            let ready = ready.load(Ordering::Relaxed);
            (
                200,
                "application/json",
                format!(r#"{{"ok":true,"ready":{ready}}}"#),
            )
        }
        _ => (
            404,
            "application/json",
            r#"{"ok":false,"error":"not found"}"#.into(),
        ),
    };

    let resp = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{payload}",
        reason(status),
        payload.len(),
    );
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    }
}

fn parse_http(raw: &str) -> Result<(String, String, String), String> {
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
        .unwrap_or((raw, ""));
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("no method")?.to_uppercase();
    let path = parts
        .next()
        .ok_or("no path")?
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();
    Ok((method, path, body.to_string()))
}
