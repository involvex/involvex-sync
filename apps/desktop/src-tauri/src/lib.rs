mod firewall;
mod keys;
mod mdns;
mod ws;

use keys::{StoredDeviceKeys, StoredPeer};
use mdns::MdnsAdvertiser;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
use ws::WsHub;

const DEFAULT_PORT: u16 = 17391;

struct AppState {
    hub: Arc<WsHub>,
    mdns: Mutex<Option<MdnsAdvertiser>>,
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub = WsHub::new(DEFAULT_PORT);

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
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let hub_clone = hub.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = ws::start_listener(handle, hub_clone).await {
                    eprintln!("websocket listener failed: {err}");
                }
            });

            let show_i = MenuItem::with_id(app, "show", "Open involvex Sync", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
