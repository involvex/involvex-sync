//! Best-effort private-profile firewall rule on Windows.
//! Requires elevation for netsh; returns a hint when it fails.

use std::process::Command;

use crate::shell::hide_child_console;

pub const RULE_NAME: &str = "involvex Sync LAN";

fn netsh(args: &[String]) -> Command {
    let mut cmd = Command::new("netsh");
    cmd.args(args);
    cmd.stdin(std::process::Stdio::null());
    hide_child_console(&mut cmd);
    cmd
}

pub fn ensure_inbound_rule(port: u16) -> Result<String, String> {
    // Remove stale rule first (ignore failure).
    let _ = netsh(&[
        "advfirewall".into(),
        "firewall".into(),
        "delete".into(),
        "rule".into(),
        format!("name={RULE_NAME}"),
    ])
    .output();

    let output = netsh(&[
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={RULE_NAME}"),
        "dir=in".into(),
        "action=allow".into(),
        "protocol=TCP".into(),
        format!("localport={port}"),
        // `any`, not `private`: the laptop is often on public Wi-Fi or on a
        // phone hotspot, and both are classified as public. Pairing (E2E,
        // in-person key exchange) is the gate — profile scoping is not.
        "profile=any".into(),
        "enable=yes".into(),
    ])
    .output()
    .map_err(|e| format!("netsh failed to start: {e}"))?;

    if output.status.success() {
        Ok(format!(
            "Firewall rule '{RULE_NAME}' allows TCP {port} inbound on all profiles"
        ))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Could not create firewall rule (run as admin once): {stderr}"
        ))
    }
}
