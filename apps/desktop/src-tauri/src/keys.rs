use keyring::Entry;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const SERVICE: &str = "app.involvex.sync";
const ACCOUNT: &str = "device-keys";
/// Deprecated single-peer slot, read once for migration into `PEERS_ACCOUNT`.
const PEER_ACCOUNT: &str = "paired-peer";
const PEERS_ACCOUNT: &str = "paired-peers";
const VAULT_ACCOUNT: &str = "vault-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairHex {
    pub public_key: String,
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDeviceKeys {
    pub device_id: String,
    pub ed25519: KeyPairHex,
    pub x25519: KeyPairHex,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPeer {
    pub device_id: String,
    pub name: String,
    pub device_type: String,
    pub ed25519_public_key: String,
    pub x25519_public_key: String,
    /// Last LAN address this peer was reached on (hint for reconnect).
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerList {
    pub peers: Vec<StoredPeer>,
    /** True when the old single-peer slot was folded in on this read. */
    pub migrated: bool,
}

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("keyring: {0}")]
    Keyring(String),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

fn entry(account: &str) -> Result<Entry, KeyError> {
    Entry::new(SERVICE, account).map_err(|e| KeyError::Keyring(e.to_string()))
}

pub fn load_device_keys() -> Result<Option<StoredDeviceKeys>, KeyError> {
    let e = entry(ACCOUNT)?;
    match e.get_password() {
        Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
}

pub fn save_device_keys(keys: &StoredDeviceKeys) -> Result<(), KeyError> {
    let e = entry(ACCOUNT)?;
    let raw = serde_json::to_string(keys)?;
    e.set_password(&raw)
        .map_err(|err| KeyError::Keyring(err.to_string()))
}

fn read_entry(account: &str) -> Result<Option<String>, KeyError> {
    let e = entry(account)?;
    match e.get_password() {
        Ok(raw) => Ok(Some(raw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
}

fn delete_entry(account: &str) -> Result<(), KeyError> {
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
}

/// All paired devices, newest pairing last. Reads the deprecated single-peer
/// slot once and folds it in, so an upgrading install keeps its pairing.
pub fn load_peers() -> Result<PeerList, KeyError> {
    let mut peers: Vec<StoredPeer> = match read_entry(PEERS_ACCOUNT)? {
        Some(raw) => serde_json::from_str(&raw)?,
        None => Vec::new(),
    };

    let mut migrated = false;
    if let Some(legacy) = read_entry(PEER_ACCOUNT)? {
        if let Ok(peer) = serde_json::from_str::<StoredPeer>(&legacy) {
            if !peers.iter().any(|p| p.device_id == peer.device_id) {
                peers.push(peer);
                migrated = true;
            }
            // Drop the legacy slot either way — it is superseded.
            delete_entry(PEER_ACCOUNT)?;
            if migrated {
                write_peers(&peers)?;
            }
        }
    }

    Ok(PeerList { peers, migrated })
}

pub fn save_peer(peer: &StoredPeer) -> Result<Vec<StoredPeer>, KeyError> {
    let mut peers = load_peers()?.peers;
    if let Some(existing) = peers.iter_mut().find(|p| p.device_id == peer.device_id) {
        *existing = peer.clone();
    } else {
        peers.push(peer.clone());
    }
    write_peers(&peers)?;
    Ok(peers)
}

/// Remove one pairing. Unknown ids are a no-op (`Ok`) so the UI can retry.
pub fn remove_peer(device_id: &str) -> Result<Vec<StoredPeer>, KeyError> {
    let mut peers = load_peers()?.peers;
    let before = peers.len();
    peers.retain(|p| p.device_id != device_id);
    if peers.len() == before && peers.is_empty() {
        return Ok(peers);
    }
    write_peers(&peers)?;
    Ok(peers)
}

pub fn clear_peers() -> Result<(), KeyError> {
    delete_entry(PEERS_ACCOUNT)?;
    delete_entry(PEER_ACCOUNT)?;
    Ok(())
}

fn write_peers(peers: &[StoredPeer]) -> Result<(), KeyError> {
    let e = entry(PEERS_ACCOUNT)?;
    let raw = serde_json::to_string(&peers)?;
    e.set_password(&raw)
        .map_err(|err| KeyError::Keyring(err.to_string()))
}

pub fn load_vault_key() -> Result<Option<String>, KeyError> {
    let e = entry(VAULT_ACCOUNT)?;
    match e.get_password() {
        Ok(raw) => Ok(Some(raw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
}

pub fn save_vault_key(key_hex: &str) -> Result<(), KeyError> {
    let e = entry(VAULT_ACCOUNT)?;
    e.set_password(key_hex)
        .map_err(|err| KeyError::Keyring(err.to_string()))
}

pub fn clear_vault_key() -> Result<(), KeyError> {
    delete_entry(VAULT_ACCOUNT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str) -> StoredPeer {
        StoredPeer {
            device_id: id.to_string(),
            name: format!("name-{id}"),
            device_type: "android".into(),
            ed25519_public_key: format!("ed-{id}"),
            x25519_public_key: format!("x-{id}"),
            host: None,
            port: None,
        }
    }

    #[test]
    fn peer_round_trips_json_with_optional_host() {
        let json = serde_json::to_string(&peer("a")).expect("serialize");
        let back: StoredPeer = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.device_id, "a");
        assert_eq!(back.host, None);

        let with_host = StoredPeer {
            host: Some("192.168.1.5".into()),
            port: Some(17391),
            ..peer("b")
        };
        let back: StoredPeer =
            serde_json::from_str(&serde_json::to_string(&with_host).expect("ser")).expect("deser");
        assert_eq!(back.host.as_deref(), Some("192.168.1.5"));
        assert_eq!(back.port, Some(17391));
    }

    /// Legacy keyring blobs have no host/port fields — they must still load.
    #[test]
    fn legacy_peer_json_without_host_deserializes() {
        let legacy = r#"{"deviceId":"a","name":"n","deviceType":"android","ed25519PublicKey":"e","x25519PublicKey":"x"}"#;
        let back: StoredPeer = serde_json::from_str(legacy).expect("deserialize");
        assert_eq!(back.device_id, "a");
        assert!(back.host.is_none());
    }

    #[test]
    fn peer_list_json_round_trips() {
        let list = vec![peer("a"), peer("b")];
        let raw = serde_json::to_string(&list).expect("serialize");
        let back: Vec<StoredPeer> = serde_json::from_str(&raw).expect("deserialize");
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].device_id, "b");
    }
}
