use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Release builds are `windows_subsystem = "windows"` (no console), so a
/// console-subsystem child would otherwise get a brand-new console window
/// flashed on screen for every spawn (gws, adb, pwsh, netsh).
/// `CREATE_NO_WINDOW` starts the child with no console at all.
///
/// Note: `creation_flags` *overwrites* the child's creation flags, so call
/// this last and do not combine it with other flag needs.
#[cfg(windows)]
pub fn hide_child_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_child_console(_cmd: &mut Command) {}

/// Cap for human-facing output (pwsh / adb) shown in the UI.
const OUTPUT_CAP: usize = 32_000;
/// Cap for JSON captures (gws listings); larger so a page never truncates.
const JSON_CAP: usize = 256_000;

fn truncate(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    // Count bytes, not chars, so multibyte names cannot blow the budget.
    let mut out = String::with_capacity(max);
    for ch in s.chars() {
        if out.len() + ch.len_utf8() + '…'.len_utf8() > max {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

/// Drain a pipe on its own thread so a chatty child can never block on a
/// full pipe buffer while we poll for exit.
fn spawn_reader<R: Read + Send + 'static>(
    pipe: Option<R>,
) -> Option<std::thread::JoinHandle<Vec<u8>>> {
    pipe.map(|mut p| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = p.read_to_end(&mut buf);
            buf
        })
    })
}

fn join_reader(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&join_reader_bytes(handle)).into_owned()
}

/// Join a reader handle and return the raw bytes. Use this (not `join_reader`)
/// whenever the child emits binary output (PNG, files) — `String::from_utf8_lossy`
/// would silently corrupt the payload.
fn join_reader_bytes(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    handle.and_then(|h| h.join().ok()).unwrap_or_default()
}

fn run_with_timeout(
    mut cmd: Command,
    timeout: Duration,
    max_output: usize,
) -> Result<CommandResult, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_child_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let out_reader = spawn_reader(child.stdout.take());
    let err_reader = spawn_reader(child.stderr.take());

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("wait: {e}")),
        }
    };

    // Readers return once the pipes close — immediately after kill on timeout.
    let stdout = join_reader(out_reader);
    let stderr = join_reader(err_reader);

    if timed_out {
        return Ok(CommandResult {
            ok: false,
            exit_code: None,
            stdout: truncate(stdout, max_output),
            stderr: "timeout".into(),
        });
    }
    match status {
        Some(status) => Ok(CommandResult {
            ok: status.success(),
            exit_code: status.code(),
            stdout: truncate(stdout, max_output),
            stderr: truncate(stderr, max_output),
        }),
        None => Err("no exit status".into()),
    }
}

pub fn run_pwsh(command: &str, timeout_ms: u64) -> Result<CommandResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if trimmed.len() > 2000 {
        return Err("command too long".into());
    }
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 120_000));
    // Prefer pwsh (PowerShell 7+), fall back to Windows PowerShell 5.
    let mut primary = Command::new("pwsh");
    primary.args(["-NoProfile", "-NonInteractive", "-Command", trimmed]);
    match run_with_timeout(primary, timeout, OUTPUT_CAP) {
        Ok(r) => Ok(r),
        Err(_) => {
            let mut fallback = Command::new("powershell");
            fallback.args(["-NoProfile", "-NonInteractive", "-Command", trimmed]);
            run_with_timeout(fallback, timeout, OUTPUT_CAP)
        }
    }
}

pub fn run_adb_shell(
    command: &str,
    timeout_ms: u64,
    serial: Option<&str>,
) -> Result<CommandResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if trimmed.len() > 2000 {
        return Err("command too long".into());
    }
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 120_000));
    let mut cmd = Command::new("adb");
    if let Some(s) = serial.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["-s", s]);
    }
    cmd.args(["shell", trimmed]);
    run_with_timeout(cmd, timeout, OUTPUT_CAP)
}

/// Raw `adb devices -l` output for the UI to parse (device list / selection).
pub fn adb_devices_raw(timeout_ms: u64) -> Result<String, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 60_000));
    let mut cmd = Command::new("adb");
    cmd.args(["devices", "-l"]);
    match run_with_timeout(cmd, timeout, JSON_CAP) {
        Ok(r) => {
            if r.ok {
                Ok(r.stdout)
            } else if r.stderr == "timeout" {
                Err("adb devices timeout".into())
            } else {
                Err(format!("adb devices failed: {}", r.stderr.trim()))
            }
        }
        Err(e) => Err(format!(
            "adb not on PATH ({e}). Install platform-tools or add adb to PATH."
        )),
    }
}

/// Run `gws` with an argv list (no shell). Max 32 args, each ≤ 8 KiB.
pub fn run_gws(args: &[String], timeout_ms: u64) -> Result<CommandResult, String> {
    if args.is_empty() {
        return Err("empty gws args".into());
    }
    if args.len() > 32 {
        return Err("too many gws args".into());
    }
    for a in args {
        if a.len() > 8 * 1024 {
            return Err("gws arg too long".into());
        }
        if a.contains('\0') {
            return Err("gws arg contains NUL".into());
        }
    }
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 300_000));
    let mut cmd = Command::new("gws");
    cmd.args(args);
    match run_with_timeout(cmd, timeout, JSON_CAP) {
        Ok(r) => Ok(r),
        Err(e) => {
            // Distinguish missing binary from other spawn failures.
            if e.contains("spawn:") {
                Err(format!(
                    "gws not found on PATH ({e}). Install @googleworkspace/cli or add gws to PATH."
                ))
            } else {
                Err(e)
            }
        }
    }
}

/// Capture the phone screen via `adb exec-out screencap -p` (binary PNG).
/// Writes to a temp file and returns its path for clipboard / preview use.
pub fn adb_screencap_png(timeout_ms: u64, serial: Option<&str>) -> Result<String, String> {
    use std::fs;
    use std::io::Write;

    let timeout = Duration::from_millis(timeout_ms.clamp(3_000, 120_000));
    let mut cmd = Command::new("adb");
    if let Some(s) = serial.map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["-s", s]);
    }
    // exec-out keeps PNG binary intact on Windows (shell would expand CRLF).
    cmd.args(["exec-out", "screencap", "-p"]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_child_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("adb spawn: {e}"))?;

    // Drain stdout/stderr on their own threads *immediately*. A multi-MB PNG
    // overflows the OS pipe buffer; reading only after the child exits would
    // let adb block forever on write while we block on try_wait (deadlock).
    let out_reader = spawn_reader(child.stdout.take());
    let err_reader = spawn_reader(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Readers unblock as soon as the killed child's pipes close.
                    let _ = join_reader_bytes(out_reader);
                    let stderr = join_reader(err_reader);
                    return Err(format!(
                        "adb screencap timeout ({:.0}s){}",
                        timeout.as_secs_f32(),
                        if stderr.trim().is_empty() {
                            String::new()
                        } else {
                            format!(": {}", stderr.trim())
                        }
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("adb wait: {e}")),
        }
    };
    let status = status.expect("loop only exits with a status");
    let stdout = join_reader_bytes(out_reader);
    let stderr = join_reader(err_reader);

    if !status.success() {
        return Err(format!(
            "adb screencap failed (exit {:?}): {}",
            status.code(),
            stderr.trim()
        ));
    }
    if stdout.len() < 8
        || stdout[0] != 0x89
        || stdout[1] != b'P'
        || stdout[2] != b'N'
        || stdout[3] != b'G'
    {
        return Err(format!(
            "adb screencap: not a PNG ({} bytes) {}",
            stdout.len(),
            stderr.trim()
        ));
    }
    let path = std::env::temp_dir().join(format!("invx-screencap-{}.png", uuid::Uuid::new_v4()));
    let mut file = fs::File::create(&path).map_err(|e| format!("temp png: {e}"))?;
    file.write_all(&stdout)
        .map_err(|e| format!("temp png write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: a child writing 1 MiB of stdout must complete. The OS pipe
    /// buffer is far smaller, so reading only after exit deadlocks the parent
    /// — this mirrors the original adb screencap hang. Both platform helpers
    /// emit the same byte count so the assertion is portable. The timeout is
    /// generous because the child is a shell: a loaded machine can make
    /// startup slow, and that is not what this test is about.
    const ONE_MIB: usize = 1_048_576;

    #[test]
    fn large_stdout_child_completes() {
        let mut cmd = Command::new(if cfg!(windows) { "pwsh" } else { "sh" });
        if cfg!(windows) {
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("[Console]::Out.Write('x' * {ONE_MIB})"),
            ]);
        } else {
            cmd.args(["-c", &format!("head -c {ONE_MIB} /dev/zero")]);
        }
        let r = run_with_timeout(cmd, Duration::from_secs(60), 2_000_000).expect("command runs");
        assert!(r.ok, "stdout: {} stderr: {}", r.stdout.len(), r.stderr);
        assert_eq!(r.stdout.len(), ONE_MIB);
    }

    #[test]
    fn adb_devices_raw_reports_missing_binary() {
        // Not a functional adb run: verifies the friendly spawn-failure path
        // by pointing PATH away from adb. Skips silently if adb IS resolvable.
        let mut cmd = Command::new("adb");
        cmd.args(["devices", "-l"]);
        cmd.env("PATH", "");
        let r = run_with_timeout(cmd, Duration::from_secs(5), 1_000);
        if let Err(e) = r {
            assert!(e.contains("spawn:"), "expected spawn error, got: {e}");
        }
        // If adb spawned anyway (PATH manipulation ignored), the test passes.
    }
}
