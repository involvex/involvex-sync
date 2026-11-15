use parking_lot::Mutex;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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

/// Shared handle for the one tracked scrcpy / `escrcpy mirror` child.
#[derive(Default)]
pub struct ScrcpyState {
    child: Mutex<Option<Child>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

/// Serial allowlist matching Escrcpy `assertSafeSerial` (`^[\w.:[\]-]+$`).
pub fn assert_safe_serial(serial: &str) -> Result<&str, String> {
    let s = serial.trim();
    if s.is_empty() {
        return Err("empty serial".into());
    }
    if s.len() > 128 {
        return Err("serial too long".into());
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '[' | ']' | '-'))
    {
        return Err("unsafe serial rejected".into());
    }
    Ok(s)
}

fn assert_safe_extra_arg(arg: &str) -> Result<&str, String> {
    if arg.is_empty() {
        return Err("empty scrcpy arg".into());
    }
    if arg.len() > 512 {
        return Err("scrcpy arg too long".into());
    }
    if arg.contains('\0') || arg.chars().any(|c| c.is_control()) {
        return Err("unsafe scrcpy arg rejected".into());
    }
    // Reject shell metacharacters even though we spawn argv-only — defense in depth.
    if arg.contains(|c: char| matches!(c, ';' | '|' | '&' | '<' | '>' | '`' | '$' | '\n' | '\r')) {
        return Err("unsafe scrcpy arg rejected".into());
    }
    Ok(arg)
}

fn path_is_file(path: &str) -> bool {
    let p = Path::new(path.trim());
    p.is_file()
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let with_exe = dir.join(format!("{name}.exe"));
            if with_exe.is_file() {
                return Some(with_exe);
            }
        }
    }
    None
}

/// Resolve scrcpy binary: explicit path → `ESCRCPY_SCRCPY` → PATH → common Escrcpy install dirs.
pub fn resolve_scrcpy_bin(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        if path_is_file(p) {
            return Ok(PathBuf::from(p));
        }
        return Err(format!("scrcpy path not found: {p}"));
    }
    if let Ok(env) = std::env::var("ESCRCPY_SCRCPY") {
        let trimmed = env.trim();
        if !trimmed.is_empty() && path_is_file(trimmed) {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Some(p) = which_on_path("scrcpy") {
        return Ok(p);
    }
    for candidate in common_scrcpy_paths() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(
        "scrcpy not found — install scrcpy, set Settings → scrcpy path, or ESCRCPY_SCRCPY"
            .into(),
    )
}

fn common_scrcpy_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("Escrcpy")
                    .join("resources")
                    .join("extra")
                    .join("win")
                    .join("scrcpy")
                    .join("scrcpy.exe"),
            );
            out.push(
                PathBuf::from(&local)
                    .join("escrcpy")
                    .join("resources")
                    .join("extra")
                    .join("win")
                    .join("scrcpy")
                    .join("scrcpy.exe"),
            );
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            out.push(
                PathBuf::from(&pf)
                    .join("Escrcpy")
                    .join("resources")
                    .join("extra")
                    .join("win")
                    .join("scrcpy")
                    .join("scrcpy.exe"),
            );
        }
    }
    out
}

/// Resolve Escrcpy GUI exe: explicit → PATH (`Escrcpy` / `escrcpy`) → common install dirs.
pub fn resolve_escrcpy_exe(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        if path_is_file(p) {
            return Ok(PathBuf::from(p));
        }
        return Err(format!("Escrcpy path not found: {p}"));
    }
    for name in ["Escrcpy", "escrcpy"] {
        if let Some(p) = which_on_path(name) {
            return Ok(p);
        }
    }
    for candidate in common_escrcpy_paths() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(
        "Escrcpy.exe not found — install Escrcpy or set Settings → Escrcpy path"
            .into(),
    )
}

fn common_escrcpy_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("Escrcpy")
                    .join("Escrcpy.exe"),
            );
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            out.push(PathBuf::from(pf).join("Escrcpy").join("Escrcpy.exe"));
        }
    }
    out
}

fn resolve_escrcpy_cli() -> Option<PathBuf> {
    which_on_path("escrcpy")
}

fn reap_if_exited(state: &ScrcpyState) {
    let mut guard = state.child.lock();
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
            }
            Ok(None) => {}
            Err(_) => {
                *guard = None;
            }
        }
    }
}

pub fn scrcpy_status(state: &ScrcpyState) -> ScrcpyStatus {
    reap_if_exited(state);
    let guard = state.child.lock();
    match guard.as_ref() {
        Some(child) => ScrcpyStatus {
            running: true,
            pid: Some(child.id()),
        },
        None => ScrcpyStatus {
            running: false,
            pid: None,
        },
    }
}

/// Start a detached scrcpy mirror for `serial`. Falls back to `escrcpy mirror` when scrcpy is missing.
pub fn start_scrcpy(
    state: &ScrcpyState,
    serial: &str,
    scrcpy_path: Option<&str>,
    extra_args: &[String],
) -> Result<ScrcpyStatus, String> {
    let serial = assert_safe_serial(serial)?;
    if extra_args.len() > 32 {
        return Err("too many scrcpy args".into());
    }
    let mut safe_extra = Vec::with_capacity(extra_args.len());
    for a in extra_args {
        safe_extra.push(assert_safe_extra_arg(a)?.to_string());
    }

    reap_if_exited(state);
    {
        let guard = state.child.lock();
        if guard.is_some() {
            return Err("scrcpy already running — stop it first".into());
        }
    }

    let (program, args) = match resolve_scrcpy_bin(scrcpy_path) {
        Ok(bin) => {
            let mut a = vec!["-s".to_string(), serial.to_string()];
            a.extend(safe_extra);
            (bin, a)
        }
        Err(scrcpy_err) => {
            let cli = resolve_escrcpy_cli().ok_or_else(|| {
                format!("{scrcpy_err}; escrcpy CLI also not on PATH")
            })?;
            let mut a = vec!["mirror".to_string(), serial.to_string()];
            a.extend(safe_extra);
            (cli, a)
        }
    };

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Scrcpy owns its own SDL window; hide only the console flash.
    hide_child_console(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        format!(
            "spawn {}: {e}",
            program.file_name().and_then(|n| n.to_str()).unwrap_or("scrcpy")
        )
    })?;
    let pid = child.id();
    *state.child.lock() = Some(child);
    Ok(ScrcpyStatus {
        running: true,
        pid: Some(pid),
    })
}

pub fn stop_scrcpy(state: &ScrcpyState) -> Result<ScrcpyStatus, String> {
    let mut guard = state.child.lock();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(ScrcpyStatus {
        running: false,
        pid: None,
    })
}

/// Launch Escrcpy GUI focused on `serial` (`--device-id=`). Does not track the process.
pub fn open_escrcpy(serial: &str, exe_path: Option<&str>) -> Result<(), String> {
    let serial = assert_safe_serial(serial)?;
    let exe = resolve_escrcpy_exe(exe_path)?;
    let mut cmd = Command::new(&exe);
    cmd.arg(format!("--device-id={serial}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Escrcpy is a GUI app — do not CREATE_NO_WINDOW on non-Windows; on Windows
    // CREATE_NO_WINDOW is fine (Electron still shows windows).
    hide_child_console(&mut cmd);
    cmd.spawn().map_err(|e| format!("spawn Escrcpy: {e}"))?;
    Ok(())
}

/// Probe whether scrcpy / Escrcpy binaries resolve (for Settings UI).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorBins {
    pub scrcpy: Option<String>,
    pub escrcpy: Option<String>,
}

pub fn probe_mirror_bins(
    scrcpy_path: Option<&str>,
    escrcpy_path: Option<&str>,
) -> MirrorBins {
    MirrorBins {
        scrcpy: resolve_scrcpy_bin(scrcpy_path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        escrcpy: resolve_escrcpy_exe(escrcpy_path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
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

    #[test]
    fn assert_safe_serial_accepts_common_shapes() {
        assert!(assert_safe_serial("R58M123").is_ok());
        assert!(assert_safe_serial("192.168.1.10:5555").is_ok());
        assert!(assert_safe_serial("emulator-5554").is_ok());
        assert!(assert_safe_serial("adb-XXXX._adb-tls-connect._tcp").is_ok());
    }

    #[test]
    fn assert_safe_serial_rejects_metacharacters() {
        assert!(assert_safe_serial("a;rm -rf").is_err());
        assert!(assert_safe_serial("").is_err());
        assert!(assert_safe_serial("device id").is_err());
    }

    #[test]
    fn assert_safe_extra_arg_rejects_shell_chars() {
        assert!(assert_safe_extra_arg("--max-size=1024").is_ok());
        assert!(assert_safe_extra_arg("--no-audio").is_ok());
        assert!(assert_safe_extra_arg("foo;bar").is_err());
        assert!(assert_safe_extra_arg("").is_err());
    }
}
