//! Stores marked hidden stay out of every list until the password is given, and go away again when
//! asked or after a while without use.

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

static REVEALED: AtomicBool = AtomicBool::new(false);
static LAST_USE: AtomicU64 = AtomicU64::new(0);

const SETTING: &str = "hidden";
const DEFAULT_MINUTES: u32 = 10;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    password_hash: String,
    /// Minutes without use before hidden stores go away again; 0 keeps them until asked.
    timeout_minutes: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { password_hash: String::new(), timeout_minutes: DEFAULT_MINUTES }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    password_set: bool,
    revealed: bool,
    timeout_minutes: u32,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

fn load() -> Settings {
    super::db::setting(SETTING).and_then(Result::ok).unwrap_or_default()
}

fn status() -> Status {
    let settings = load();
    Status { password_set: !settings.password_hash.is_empty(), revealed: revealed(), timeout_minutes: settings.timeout_minutes }
}

pub fn revealed() -> bool {
    REVEALED.load(Ordering::SeqCst)
}

/// Notes that the app is in use, which puts off hiding again.
pub fn touch() {
    LAST_USE.store(now_ms(), Ordering::SeqCst);
}

fn hash(password: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    let salt = SaltString::encode_b64(&bytes).map_err(|error| error.to_string())?;
    Argon2::default().hash_password(password.as_bytes(), &salt).map(|hash| hash.to_string()).map_err(|error| error.to_string())
}

fn matches(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored).is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

fn changed(app: &AppHandle) {
    let _ = app.emit("hidden-changed", status());
    super::dropbox::refresh(app);
}

#[tauri::command]
pub fn hidden_status() -> Status {
    status()
}

/// Shows hidden stores. The first time it sets the password instead of checking it.
#[tauri::command]
pub async fn hidden_unlock(app: AppHandle, password: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = load();
        if settings.password_hash.is_empty() {
            if password.chars().count() < 4 {
                return Err("Use at least 4 characters.".to_string());
            }
            settings.password_hash = hash(&password)?;
            super::db::set_setting(SETTING, &settings)?;
        } else if !matches(&password, &settings.password_hash) {
            // A wrong guess costs time, so guessing many is slow.
            thread::sleep(Duration::from_millis(800));
            return Err("Wrong password.".to_string());
        }
        touch();
        REVEALED.store(true, Ordering::SeqCst);
        changed(&app);
        Ok(status())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn hidden_lock(app: AppHandle) -> Status {
    conceal(&app);
    status()
}

#[tauri::command]
pub fn hidden_activity() {
    touch();
}

#[tauri::command]
pub fn hidden_configure(app: AppHandle, timeout_minutes: u32) -> Result<Status, String> {
    if !revealed() {
        return Err("Not available.".into());
    }
    let mut settings = load();
    settings.timeout_minutes = timeout_minutes.min(24 * 60);
    super::db::set_setting(SETTING, &settings)?;
    touch();
    changed(&app);
    Ok(status())
}

fn conceal(app: &AppHandle) {
    REVEALED.store(false, Ordering::SeqCst);
    super::dropbox::leave_hidden_store(app);
    changed(app);
}

/// Hides again after the chosen time without use.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(10));
        if !revealed() {
            continue;
        }
        let minutes = load().timeout_minutes;
        if minutes > 0 && now_ms().saturating_sub(LAST_USE.load(Ordering::SeqCst)) > u64::from(minutes) * 60_000 {
            conceal(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_kept_as_salted_hashes() {
        let first = hash("open sesame").unwrap();
        let second = hash("open sesame").unwrap();
        assert_ne!(first, second, "each hash has its own salt");
        assert!(!first.contains("open sesame"));
        assert!(matches("open sesame", &first) && matches("open sesame", &second));
        assert!(!matches("open Sesame", &first));
        assert!(!matches("anything", "not a hash"));
    }
}
