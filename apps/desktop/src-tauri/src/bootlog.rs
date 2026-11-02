//! Persist startup diagnostics for silent Windows GUI builds.
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("involvex-sync"))
}

pub fn log_path() -> Option<PathBuf> {
    log_dir().map(|d| d.join("boot.log"))
}

pub fn write(line: &str) {
    let Some(path) = log_path() else {
        eprintln!("{line}");
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{ts}] {line}");
    }
    eprintln!("{line}");
}

/// Show a blocking Windows message box so silent GUI crashes are visible.
#[cfg(windows)]
pub fn alert(title: &str, message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            flags: u32,
        ) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let text = wide(message);
    let caption = wide(title);
    unsafe {
        MessageBoxW(null_mut(), text.as_ptr(), caption.as_ptr(), 0x10);
    }
}

#[cfg(not(windows))]
pub fn alert(title: &str, message: &str) {
    eprintln!("{title}: {message}");
}

pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        write(&format!("PANIC: {msg}"));
        if let Some(path) = log_path() {
            alert(
                "involvex Sync crashed",
                &format!("Startup failed.\n\n{msg}\n\nDetails: {}", path.display()),
            );
        } else {
            alert("involvex Sync crashed", &msg);
        }
    }));
}
