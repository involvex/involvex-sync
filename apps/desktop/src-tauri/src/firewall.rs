//! Best-effort private-profile firewall rule on Windows.
//! Requires elevation for netsh; returns a hint when it fails.

use std::process::Command;

pub const RULE_NAME: &str = "involvex Sync LAN";

pub fn ensure_private_inbound_rule(port: u16) -> Result<String, String> {
    // Remove stale rule first (ignore failure).
    let _ = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "delete",
            "rule",
            &format!("name={RULE_NAME}"),
        ])
        .output();

    let output = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={RULE_NAME}"),
            "dir=in",
            "action=allow",
            "protocol=TCP",
            &format!("localport={port}"),
            "profile=private",
            "enable=yes",
        ])
        .output()
        .map_err(|e| format!("netsh failed to start: {e}"))?;

    if output.status.success() {
        Ok(format!(
            "Firewall rule '{RULE_NAME}' allows TCP {port} on private profiles"
        ))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Could not create firewall rule (run as admin once): {stderr}"
        ))
    }
}
