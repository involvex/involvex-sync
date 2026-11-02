use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::collections::HashMap;
use thiserror::Error;

const SERVICE_TYPE: &str = "_invxconnect._tcp.local.";

#[derive(Debug, Error)]
pub enum MdnsError {
    #[error("mdns: {0}")]
    Daemon(String),
}

pub struct MdnsAdvertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MdnsAdvertiser {
    pub fn start(
        device_name: &str,
        device_id: &str,
        port: u16,
        host_ip: &str,
    ) -> Result<Self, MdnsError> {
        let daemon = ServiceDaemon::new().map_err(|e| MdnsError::Daemon(e.to_string()))?;
        let mut props = HashMap::new();
        props.insert("id".to_string(), device_id.to_string());
        props.insert("type".to_string(), "windows".to_string());
        props.insert("name".to_string(), device_name.to_string());

        let host_name = format!("{device_id}.local.");
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            device_name,
            &host_name,
            host_ip,
            port,
            Some(props),
        )
        .map_err(|e| MdnsError::Daemon(e.to_string()))?;

        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|e| MdnsError::Daemon(e.to_string()))?;

        Ok(Self { daemon, fullname })
    }
}

impl Drop for MdnsAdvertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
    }
}
