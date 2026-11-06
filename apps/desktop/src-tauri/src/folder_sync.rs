//! Watch a PC folder and emit ready events for outbound phone sync.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(750);
const STABLE_CHECKS: u32 = 2;

#[derive(Default)]
pub struct FolderSyncState {
    inner: Mutex<Option<WatcherInner>>,
}

struct WatcherInner {
    _watcher: RecommendedWatcher,
    root: PathBuf,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncReady {
    pub path: String,
    pub relative_name: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileInfo {
    pub path: String,
    pub relative_name: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFilePayload {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub relative_name: String,
}

fn is_ignored_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if name.starts_with('.') {
        return true;
    }
    lower.ends_with(".tmp")
        || lower.ends_with(".temp")
        || lower.ends_with(".partial")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".download")
        || name.ends_with('~')
        || lower == "thumbs.db"
        || lower == "desktop.ini"
}

fn flatten_relative(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("__")
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_under_root(root: &Path, path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root_can = fs::canonicalize(root).map_err(|e| format!("root: {e}"))?;
    let path_can = fs::canonicalize(path).map_err(|e| format!("path: {e}"))?;
    if !path_can.starts_with(&root_can) {
        return Err("path escapes sync root".into());
    }
    let rel = path_can
        .strip_prefix(&root_can)
        .map_err(|_| "path escapes sync root".to_string())?
        .to_path_buf();
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("path escapes sync root".into());
    }
    Ok((path_can, rel))
}

fn emit_ready(app: &AppHandle, root: &Path, path: &Path) {
    let Ok((abs, rel)) = resolve_under_root(root, path) else {
        return;
    };
    if !abs.is_file() {
        return;
    }
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if is_ignored_name(&name) {
        return;
    }
    let Ok(meta) = fs::metadata(&abs) else {
        return;
    };
    let relative_name = {
        let flat = flatten_relative(&rel);
        if flat.is_empty() {
            name
        } else {
            flat
        }
    };
    let payload = FolderSyncReady {
        path: abs.to_string_lossy().to_string(),
        relative_name,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    };
    let _ = app.emit("folder-sync-ready", payload);
}

pub fn start_watch(app: AppHandle, state: &FolderSyncState, dir: String) -> Result<String, String> {
    stop_watch(state);

    let root = PathBuf::from(dir.trim());
    if root.as_os_str().is_empty() {
        return Err("empty sync folder".into());
    }
    fs::create_dir_all(&root).map_err(|e| format!("create sync folder: {e}"))?;
    let root_can = fs::canonicalize(&root).map_err(|e| format!("canonicalize: {e}"))?;

    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        let Ok(event) = res else {
            return;
        };
        match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any => {}
            _ => return,
        }
        for path in event.paths {
            let _ = tx.send(path);
        }
    })
    .map_err(|e| format!("watcher: {e}"))?;

    watcher
        .watch(&root_can, RecursiveMode::Recursive)
        .map_err(|e| format!("watch: {e}"))?;

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag = stop.clone();
    let app_clone = app.clone();
    let root_for_thread = root_can.clone();

    thread::spawn(move || {
        let mut pending: HashMap<PathBuf, (u64, u32, Instant)> = HashMap::new();
        loop {
            if stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            // Drain channel with timeout so we can re-check pending.
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(path) => {
                    if path.is_file() {
                        pending
                            .entry(path)
                            .or_insert_with(|| (0, 0, Instant::now()));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            let now = Instant::now();
            let keys: Vec<PathBuf> = pending.keys().cloned().collect();
            let mut ready: Vec<PathBuf> = Vec::new();
            for path in keys {
                let Some(entry) = pending.get_mut(&path) else {
                    continue;
                };
                if now.duration_since(entry.2) < DEBOUNCE {
                    continue;
                }
                let Ok(meta) = fs::metadata(&path) else {
                    pending.remove(&path);
                    continue;
                };
                if !meta.is_file() {
                    pending.remove(&path);
                    continue;
                }
                let len = meta.len();
                if len == entry.0 {
                    entry.1 = entry.1.saturating_add(1);
                } else {
                    entry.0 = len;
                    entry.1 = 0;
                    entry.2 = now;
                }
                if entry.1 >= STABLE_CHECKS {
                    ready.push(path);
                }
            }
            for path in ready {
                pending.remove(&path);
                emit_ready(&app_clone, &root_for_thread, &path);
            }
        }
    });

    *state.inner.lock() = Some(WatcherInner {
        _watcher: watcher,
        root: root_can.clone(),
        stop,
    });

    Ok(root_can.to_string_lossy().to_string())
}

pub fn stop_watch(state: &FolderSyncState) {
    if let Some(inner) = state.inner.lock().take() {
        inner
            .stop
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

pub fn list_files(dir: String) -> Result<Vec<SyncFileInfo>, String> {
    let root = PathBuf::from(dir.trim());
    if root.as_os_str().is_empty() {
        return Err("empty sync folder".into());
    }
    fs::create_dir_all(&root).map_err(|e| format!("create sync folder: {e}"))?;
    let root_can = fs::canonicalize(&root).map_err(|e| format!("canonicalize: {e}"))?;
    let mut out = Vec::new();
    collect_files(&root_can, &root_can, &mut out)?;
    out.sort_by(|a, b| a.relative_name.cmp(&b.relative_name));
    Ok(out)
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<SyncFileInfo>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_name(&name) {
            continue;
        }
        let meta = entry.metadata().map_err(|e| format!("meta: {e}"))?;
        if meta.is_dir() {
            collect_files(root, &path, out)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "path escapes sync root".to_string())?;
        let relative_name = flatten_relative(rel);
        out.push(SyncFileInfo {
            path: path.to_string_lossy().to_string(),
            relative_name,
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        });
    }
    Ok(())
}

pub fn read_file(path: String, root: String) -> Result<SyncFilePayload, String> {
    use base64::Engine;

    let root = PathBuf::from(root.trim());
    let path = PathBuf::from(path.trim());
    let (abs, rel) = resolve_under_root(&root, &path)?;
    if !abs.is_file() {
        return Err("not a file".into());
    }
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.bin".into());
    if is_ignored_name(&name) {
        return Err("ignored file name".into());
    }
    let meta = fs::metadata(&abs).map_err(|e| format!("meta: {e}"))?;
    let bytes = fs::read(&abs).map_err(|e| format!("read: {e}"))?;
    let mime = mime_guess::from_path(&abs)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let relative_name = {
        let flat = flatten_relative(&rel);
        if flat.is_empty() {
            name.clone()
        } else {
            flat
        }
    };
    Ok(SyncFilePayload {
        name: relative_name.clone(),
        mime_type: mime,
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        relative_name,
    })
}
