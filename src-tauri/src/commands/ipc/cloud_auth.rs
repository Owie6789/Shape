use crate::core::error::AppError;

fn entry(k: &str) -> Result<keyring::Entry, AppError> {
    let a = match k { "access" => "access-token", "refresh" => "refresh-token", _ => return Err(AppError::Message("Unknown key.".into())) };
    keyring::Entry::new("shape-cloud-auth", a).map_err(|e| AppError::Message(e.to_string()))
}

#[tauri::command]
pub async fn cloud_auth_get(key: String) -> Result<Option<String>, AppError> {
    tokio::task::spawn_blocking(move || match entry(&key)?.get_password() { Ok(v) if !v.is_empty() => Ok(Some(v)), Ok(_) | Err(keyring::Error::NoEntry) => Ok(None), Err(e) => Err(AppError::Message(e.to_string())) }).await.map_err(|e| AppError::Message(e.to_string()))?
}

#[tauri::command]
pub async fn cloud_auth_set(key: String, value: Option<String>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || match value.filter(|v| !v.is_empty()) { Some(v) => entry(&key)?.set_password(&v).map_err(|e| AppError::Message(e.to_string())), None => match entry(&key)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(e) => Err(AppError::Message(e.to_string())) } }).await.map_err(|e| AppError::Message(e.to_string()))?
}
