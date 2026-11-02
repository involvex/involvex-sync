mod control;
mod firewall;
mod keys;
mod mdns;
mod ws;

use keys::{StoredDeviceKeys, StoredPeer};
use mdns::MdnsAdvertiser;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WindowEvent,
};
use ws::WsHub;

const DEFAULT_PORT: u16 = 17391;

struct AppState {
    hub: Arc<WsHub>,
    mdns: Mutex<Option<MdnsAdvertiser>>,
    /// After startup grace, minimize may hide to tray.
    tray_ready: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LanInfo {
    ip: Option<String>,
    port: u16,
    status: ws::WsStatus,
}

#[tauri::command]
fn get_lan_info(state: State<'_, AppState>) -> LanInfo {
    LanInfo {
        ip: local_ip_address::local_ip()
            .ok()
            .map(|ip| ip.to_string()),
        port: DEFAULT_PORT,
        status: state.hub.status(),
    }
}

#[tauri::command]
fn ws_send(state: State<'_, AppState>, message: String) -> Result<(), String> {
    state.hub.send_to_peer(message)
}

#[tauri::command]
fn open_allowed_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("only http(s) urls are allowed".into());
    }
    if trimmed.contains('@') {
        return Err("urls with credentials are blocked".into());
    }
    open::that(trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_device_keys() -> Result<Option<StoredDeviceKeys>, String> {
    keys::load_device_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_device_keys(keys: StoredDeviceKeys) -> Result<(), String> {
    keys::save_device_keys(&keys).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_peer() -> Result<Option<StoredPeer>, String> {
    keys::load_peer().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_peer(peer: StoredPeer) -> Result<(), String> {
    keys::save_peer(&peer).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_peer() -> Result<(), String> {
    keys::clear_peer().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_mdns(
    state: State<'_, AppState>,
    device_name: String,
    device_id: String,
) -> Result<String, String> {
    let ip = local_ip_address::local_ip()
        .map_err(|e| e.to_string())?
        .to_string();
    let advertiser = MdnsAdvertiser::start(&device_name, &device_id, DEFAULT_PORT, &ip)
        .map_err(|e| e.to_string())?;
    *state.mdns.lock() = Some(advertiser);
    Ok(format!("advertising _invxconnect._tcp on {ip}:{DEFAULT_PORT}"))
}

#[tauri::command]
fn ensure_firewall_rule() -> Result<String, String> {
    firewall::ensure_private_inbound_rule(DEFAULT_PORT)
}

#[tauri::command]
fn save_incoming_file(
    name: String,
    data_base64: String,
) -> Result<String, String> {
    use base64::Engine;
    use std::fs;
    use std::path::PathBuf;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64: {e}"))?;

    let safe_name = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let safe_name = if safe_name.is_empty() {
        format!("file-{}.bin", uuid::Uuid::new_v4())
    } else {
        safe_name
    };

    let dir: PathBuf = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no download dir".to_string())?
        .join("involvex-Sync");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub = WsHub::new(DEFAULT_PORT);
    let tray_ready = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(AppState {
            hub: hub.clone(),
            mdns: Mutex::new(None),
            tray_ready: tray_ready.clone(),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let hub_clone = hub.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = ws::start_listener(handle, hub_clone).await {
                    eprintln!("websocket listener failed: {err}");
                }
            });

            control::start(app.handle().clone(), hub.clone(), tray_ready.clone());

            let show_i = MenuItem::with_id(app, "show", "Open involvex Sync", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("involvex Sync")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Force the main window up — release builds were ending up tray-only
            // because early Resized/minimize events hid it during cold start.
            show_main_window(app.handle());

            let ready_flag = tray_ready.clone();
            let grace_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                show_main_window(&grace_handle);
                ready_flag.store(true, Ordering::Relaxed);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_lan_info,
            ws_send,
            open_allowed_url,
            load_device_keys,
            save_device_keys,
            load_peer,
            save_peer,
            clear_peer,
            start_mdns,
            ensure_firewall_rule,
            save_incoming_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Resized(_),
                ..
            } if label == "main" => {
                let ready = app
                    .try_state::<AppState>()
                    .map(|s| s.tray_ready.load(Ordering::Relaxed))
                    .unwrap_or(false);
                if !ready {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_minimized().unwrap_or(false) {
                        let _ = window.hide();
                        let _ = window.unminimize();
                    }
                }
            }
            _ => {}
        });
}
