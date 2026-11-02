//! Loopback HTTP control plane for the `isync` CLI (127.0.0.1 only).

use crate::ws::WsHub;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const CONTROL_PORT: u16 = 17_392;

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
}

pub fn start(app: AppHandle, hub: Arc<WsHub>, ready: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = serve(app, hub, ready).await {
            eprintln!("control server failed: {err}");
        }
    });
}

async fn serve(
    app: AppHandle,
    hub: Arc<WsHub>,
    ready: Arc<AtomicBool>,
) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", CONTROL_PORT))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{CONTROL_PORT}: {e}"))?;
    eprintln!("isync control listening on 127.0.0.1:{CONTROL_PORT}");

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
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle(stream, app, hub, ready).await {
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
            let body = StatusBody {
                ok: true,
                control: true,
                peer_connected: ws.peer_connected,
                peer_addr: ws.peer_addr,
                listening: ws.listening,
                lan_port: ws.port,
                window_visible: visible,
            };
            (
                200,
                "application/json",
                serde_json::to_string(&body).unwrap_or_else(|_| "{}".into()),
            )
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
