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

fn truncate(s: String, max: usize) -> String {
    if s.len() <= max {
        s
    } else {
        let mut out = s.chars().take(max).collect::<String>();
        out.push_str("…");
        out
    }
}

fn run_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Result<CommandResult, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                let code = status.code();
                return Ok(CommandResult {
                    ok: status.success(),
                    exit_code: code,
                    stdout: truncate(stdout, 32_000),
                    stderr: truncate(stderr, 32_000),
                });
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(CommandResult {
                        ok: false,
                        exit_code: None,
                        stdout: String::new(),
                        stderr: "timeout".into(),
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("wait: {e}")),
        }
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
    match run_with_timeout(primary, timeout) {
        Ok(r) => Ok(r),
        Err(_) => {
            let mut fallback = Command::new("powershell");
            fallback.args(["-NoProfile", "-NonInteractive", "-Command", trimmed]);
            run_with_timeout(fallback, timeout)
        }
    }
}

pub fn run_adb_shell(command: &str, timeout_ms: u64) -> Result<CommandResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if trimmed.len() > 2000 {
        return Err("command too long".into());
    }
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 120_000));
    let mut cmd = Command::new("adb");
    cmd.args(["shell", trimmed]);
    run_with_timeout(cmd, timeout)
}
