use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Connection settings for the hat server this window talks to.
///
/// The desktop app is a thin client: it holds no sessions, secrets or provider
/// keys, only the address of a server and the token used to authenticate to it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionConfig {
    /// Base URL of the hat server, e.g. `http://127.0.0.1:8787`.
    pub server_url: String,
    /// The server's `HAT_AUTH_TOKEN`. Empty when the server runs without auth.
    pub token: String,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
  Ok(dir.join("connection.json"))
}

fn read_config(path: &Path) -> ConnectionConfig {
  fs::read_to_string(path)
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

/// Write the config with owner-only permissions where the platform supports it.
///
/// The token is not a hat secret (it authenticates to the server, which owns the
/// real ones), but it should not be world-readable on a shared machine. Moving it
/// into the OS keychain is tracked as follow-up work.
fn write_config(path: &Path, config: &ConnectionConfig) -> Result<(), String> {
  let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
  fs::write(path, body).map_err(|e| format!("write config: {e}"))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
      .map_err(|e| format!("chmod config: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<ConnectionConfig, String> {
  Ok(read_config(&config_path(&app)?))
}

#[tauri::command]
fn save_config(app: AppHandle, config: ConnectionConfig) -> Result<(), String> {
  write_config(&config_path(&app)?, &config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .invoke_handler(tauri::generate_handler![load_config, save_config])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
