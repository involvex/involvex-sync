//! Put a PNG/JPEG file onto the OS clipboard as RGBA pixels.
//!
//! `@tauri-apps/plugin-clipboard-manager` `writeImage` expects image bytes /
//! RGBA, not a filesystem path — passing a path yields
//! "Expected RGBA image data, found a file path".

use arboard::{Clipboard, ImageData};
use std::borrow::Cow;
use std::fs;
use std::path::Path;

/// Decode an image file and place it on the system clipboard.
pub fn set_clipboard_image_from_path(path: &str) -> Result<(), String> {
    let p = Path::new(path.trim());
    if !p.is_file() {
        return Err(format!("clipboard image: file not found ({path})"));
    }
    let meta = fs::metadata(p).map_err(|e| format!("clipboard image meta: {e}"))?;
    // Matches read_file_base64 cap used for clipboard sync.
    if meta.len() > 12 * 1024 * 1024 {
        return Err("clipboard image: file too large".into());
    }
    let bytes = fs::read(p).map_err(|e| format!("clipboard image read: {e}"))?;
    set_clipboard_image_from_bytes(&bytes)
}

/// Decode PNG/JPEG (or any format `image` supports) bytes onto the clipboard.
pub fn set_clipboard_image_from_bytes(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("image decode: {e}"))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard open: {e}"))?;
    clipboard
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| format!("clipboard set image: {e}"))?;
    Ok(())
}
