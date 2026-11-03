mod bootlog;
mod control;
mod firewall;
mod keys;
mod mdns;
mod shell;
mod ws;

use keys::{StoredDeviceKeys, StoredPeer};
use mdns::MdnsAdvertiser;
use parking_lot::Mutex;
use serde::Serialize;
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

fn default_incoming_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no download dir".to_string())?
        .join("involvex-Sync"))
}

#[tauri::command]
fn default_incoming_dir() -> Result<String, String> {
    Ok(default_incoming_path()?.to_string_lossy().to_string())
}

#[tauri::command]
fn save_incoming_file(
    name: String,
    data_base64: String,
    directory: Option<String>,
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

    let dir: PathBuf = match directory.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => PathBuf::from(custom),
        None => default_incoming_path()?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn run_pwsh(command: String, timeout_ms: Option<u64>) -> Result<shell::CommandResult, String> {
    shell::run_pwsh(&command, timeout_ms.unwrap_or(30_000))
}

#[tauri::command]
fn run_adb_shell(
    command: String,
    timeout_ms: Option<u64>,
) -> Result<shell::CommandResult, String> {
    shell::run_adb_shell(&command, timeout_ms.unwrap_or(30_000))
}

#[tauri::command]
fn adb_screencap(timeout_ms: Option<u64>) -> Result<String, String> {
    shell::adb_screencap_png(timeout_ms.unwrap_or(20_000))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        bootlog::write("show_main_window ok");
    } else {
        bootlog::write("show_main_window: main window missing");
    }
}

#[tauri::command]
fn show_main_window_cmd(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Open involvex Sync", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("tray")
        .menu(&menu)
        .tooltip("involvex Sync")
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
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        bootlog::write("warning: no default_window_icon — tray may be invisible");
    }

    let _tray = builder.build(app)?;
    bootlog::write("tray ready");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    bootlog::install_panic_hook();
    bootlog::write("run() start");

    let hub = WsHub::new(DEFAULT_PORT);

    let app = match tauri::Builder::default()
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
            bootlog::write("setup begin");

            let handle = app.handle().clone();
            let hub_clone = hub.clone();
            tauri::async_runtime::spawn(async move {
                match ws::start_listener(handle, hub_clone).await {
                    Ok(()) => bootlog::write("ws listener exited"),
                    Err(err) => bootlog::write(&format!("websocket listener failed: {err}")),
                }
            });

            control::start(app.handle().clone(), hub.clone(), Arc::new(std::sync::atomic::AtomicBool::new(true)));

            match setup_tray(app) {
                Ok(()) => {}
                Err(err) => {
                    // Tray must not kill the whole app — window is enough.
                    bootlog::write(&format!("tray setup failed (continuing): {err}"));
                }
            }

            show_main_window(app.handle());

            let grace_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                show_main_window(&grace_handle);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                show_main_window(&grace_handle);
                bootlog::write("setup grace show done");
            });

            bootlog::write("setup ok");
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
            default_incoming_dir,
            run_pwsh,
            run_adb_shell,
            adb_screencap,
            show_main_window_cmd,
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            let msg = format!("failed to build tauri app: {err}");
            bootlog::write(&msg);
            bootlog::alert("involvex Sync", &msg);
            return;
        }
    };

    bootlog::write("entering event loop");
    app.run(|app, event| {
        if let RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
        {
            if label == "main" {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                    bootlog::write("main window hidden to tray");
                }
            }
        }
    });
}
