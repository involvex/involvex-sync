use keyring::Entry;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const SERVICE: &str = "app.involvex.sync";
const ACCOUNT: &str = "device-keys";
const PEER_ACCOUNT: &str = "paired-peer";
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

pub fn load_peer() -> Result<Option<StoredPeer>, KeyError> {
    let e = entry(PEER_ACCOUNT)?;
    match e.get_password() {
        Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
}

pub fn save_peer(peer: &StoredPeer) -> Result<(), KeyError> {
    let e = entry(PEER_ACCOUNT)?;
    let raw = serde_json::to_string(peer)?;
    e.set_password(&raw)
        .map_err(|err| KeyError::Keyring(err.to_string()))
}

pub fn clear_peer() -> Result<(), KeyError> {
    let e = entry(PEER_ACCOUNT)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
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
    let e = entry(VAULT_ACCOUNT)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(KeyError::Keyring(err.to_string())),
    }
}
