//! Inpaint's SQLite databases, both in the data directory.
//!
//! `inpaint.db` keeps settings and the user's data: the API server (with its token), Immich (with its
//! API key), image stores, drop box and tray settings, and the editor's preferences, workflows and saved
//! faces. Only the user can read it. `.cache/cache.db` keeps what can be rebuilt: store indexes and the
//! thumbnail cache's sizes and last use. The JSON files used before are imported once.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{LazyLock, Mutex, MutexGuard},
    time::{Duration, UNIX_EPOCH},
};

pub(crate) const SETTINGS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    immich INTEGER NOT NULL DEFAULT 0,
    immich_path TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

pub(crate) const CACHE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS store_pictures (
    store_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    extension TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_ms INTEGER NOT NULL,
    PRIMARY KEY (store_id, path)
);
CREATE INDEX IF NOT EXISTS store_pictures_newest ON store_pictures (store_id, modified_ms DESC, name);
CREATE INDEX IF NOT EXISTS store_pictures_path ON store_pictures (path);
CREATE TABLE IF NOT EXISTS store_scans (
    store_id TEXT PRIMARY KEY,
    other_files INTEGER NOT NULL,
    scanned_ms INTEGER NOT NULL,
    scan_seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS thumbnails (file TEXT PRIMARY KEY, bytes INTEGER NOT NULL, last_used INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS thumbnails_last_used ON thumbnails (last_used);
";

#[derive(Clone, Copy)]
enum Database {
    Settings,
    Cache,
}

// Tests use in-memory databases, so they never touch the user's data directory.
static SETTINGS: LazyLock<Mutex<Connection>> = LazyLock::new(|| Mutex::new(connect(Database::Settings)));
static CACHE: LazyLock<Mutex<Connection>> = LazyLock::new(|| Mutex::new(connect(Database::Cache)));

pub fn settings_db() -> MutexGuard<'static, Connection> {
    SETTINGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn cache_db() -> MutexGuard<'static, Connection> {
    CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Opens and prepares a database. An in-memory one stands in when the file cannot be used, so the app
/// still runs, without keeping changes.
fn connect(database: Database) -> Connection {
    let schema = match database {
        Database::Settings => SETTINGS_SCHEMA,
        Database::Cache => CACHE_SCHEMA,
    };
    let result = if cfg!(test) {
        Err("tests keep their databases in memory".to_string())
    } else {
        let folder = super::project_dir();
        match database {
            Database::Settings => open(&folder.join("inpaint.db"), true).and_then(|mut connection| migrate_settings(&mut connection, &folder).map(|_| connection)),
            Database::Cache => open(&folder.join(".cache/cache.db"), false).and_then(|mut connection| migrate_cache(&mut connection, &folder).map(|_| connection)),
        }
    };
    result.unwrap_or_else(|error| {
        if !cfg!(test) {
            eprintln!("Cannot open Inpaint's database, so changes are not kept: {error}");
        }
        let connection = Connection::open_in_memory().expect("an in-memory SQLite database");
        connection.execute_batch(schema).expect("the database tables");
        connection
    })
}

fn open(path: &Path, private: bool) -> Result<Connection, String> {
    let failed = |error: &dyn std::fmt::Display| format!("{}: {error}", path.display());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| failed(&error))?;
    }
    if private {
        // SQLite gives its journal files the database file's permissions.
        fs::OpenOptions::new().create(true).append(true).mode(0o600).open(path).map_err(|error| failed(&error))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| failed(&error))?;
    }
    let connection = Connection::open(path).map_err(|error| failed(&error))?;
    connection.busy_timeout(Duration::from_secs(5)).map_err(|error| failed(&error))?;
    connection.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(())).map_err(|error| failed(&error))?;
    connection.pragma_update(None, "synchronous", "NORMAL").map_err(|error| failed(&error))?;
    Ok(connection)
}

fn user_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// Creates the tables and, the first time, imports the JSON settings files, removing each one imported.
pub(crate) fn migrate_settings(connection: &mut Connection, folder: &Path) -> Result<(), String> {
    let failed = |error: rusqlite::Error| format!("Cannot prepare the settings database: {error}");
    connection.execute_batch(SETTINGS_SCHEMA).map_err(failed)?;
    if user_version(connection).map_err(failed)? >= 1 {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(failed)?;
    let mut imported = Vec::new();
    for (key, file) in [("server", "server.json"), ("immich", "immich.json"), ("dropbox", "dropbox.json"), ("tray", "tray.json")] {
        let Ok(text) = fs::read_to_string(folder.join(file)) else { continue };
        if let Err(error) = serde_json::from_str::<serde_json::Value>(&text) {
            eprintln!("Not importing {file}: {error}");
            continue;
        }
        transaction.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![key, text]).map_err(failed)?;
        imported.push(file);
    }
    if let Ok(text) = fs::read_to_string(folder.join("stores.json")) {
        #[derive(Deserialize)]
        struct Registry {
            #[serde(default)]
            stores: Vec<super::stores::Store>,
        }
        match serde_json::from_str::<Registry>(&text) {
            Ok(registry) => {
                for (position, store) in registry.stores.iter().enumerate() {
                    super::stores::insert(&transaction, store, position as i64).map_err(failed)?;
                }
                imported.push("stores.json");
            }
            Err(error) => eprintln!("Not importing stores.json: {error}"),
        }
    }
    transaction.pragma_update(None, "user_version", 1).map_err(failed)?;
    transaction.commit().map_err(failed)?;
    // The database holds them now, so the token and API key do not also stay in plain files.
    for file in imported {
        let _ = fs::remove_file(folder.join(file));
    }
    Ok(())
}

/// Creates the tables and, the first time, imports the store indexes saved as JSON and the thumbnails
/// already cached.
pub(crate) fn migrate_cache(connection: &mut Connection, folder: &Path) -> Result<(), String> {
    let failed = |error: rusqlite::Error| format!("Cannot prepare the cache database: {error}");
    connection.execute_batch(CACHE_SCHEMA).map_err(failed)?;
    if user_version(connection).map_err(failed)? >= 1 {
        return Ok(());
    }
    let indexes = folder.join(".cache/stores");
    let transaction = connection.transaction().map_err(failed)?;
    for entry in fs::read_dir(&indexes).into_iter().flatten().flatten() {
        let path = entry.path();
        let Some(id) = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()) else { continue };
        let Ok(bytes) = fs::read(&path) else { continue };
        if let Ok(contents) = serde_json::from_slice::<super::stores::StoreContents>(&bytes) {
            super::stores::write_index(&transaction, &id, &contents).map_err(failed)?;
        }
    }
    {
        let mut insert = transaction.prepare("INSERT OR IGNORE INTO thumbnails (file, bytes, last_used) VALUES (?1, ?2, ?3)").map_err(failed)?;
        for entry in fs::read_dir(folder.join(".cache/thumbnails")).into_iter().flatten().flatten() {
            let Ok(metadata) = entry.metadata() else { continue };
            if !metadata.is_file() {
                continue;
            }
            let used = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |time| time.as_millis() as i64);
            insert.execute(params![entry.file_name().to_string_lossy(), metadata.len() as i64, used]).map_err(failed)?;
        }
    }
    transaction.pragma_update(None, "user_version", 1).map_err(failed)?;
    transaction.commit().map_err(failed)?;
    let _ = fs::remove_dir_all(indexes);
    Ok(())
}

/// A setting saved as JSON: None when never saved, an error when it no longer fits the type.
pub fn setting<T: DeserializeOwned>(key: &str) -> Option<Result<T, String>> {
    let text: Option<String> = settings_db()
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()
        .unwrap_or_else(|error| {
            eprintln!("Cannot read the {key} settings: {error}");
            None
        });
    text.map(|text| serde_json::from_str(&text).map_err(|error| format!("Invalid {key} settings: {error}")))
}

pub fn set_setting<T: Serialize>(key: &str, value: &T) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    settings_db()
        .execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![key, text])
        .map_err(|error| format!("Cannot save the {key} settings: {error}"))?;
    Ok(())
}

const MAX_PREFERENCE_BYTES: usize = 32 << 20;

fn checked_preference(key: &str, value: Option<&str>) -> Result<(), String> {
    if !key.starts_with("inpaint.") || key.len() > 200 {
        return Err(format!("{key} is not an Inpaint preference."));
    }
    if value.is_some_and(|value| value.len() > MAX_PREFERENCE_BYTES) {
        return Err(format!("{key} is too large to keep."));
    }
    Ok(())
}

/// Every editor preference as the text it was saved as, loaded once before the window renders.
#[tauri::command]
pub fn preferences_all() -> Result<HashMap<String, String>, String> {
    let connection = settings_db();
    let failed = |error: rusqlite::Error| format!("Cannot read preferences: {error}");
    let mut statement = connection.prepare("SELECT key, value FROM preferences").map_err(failed)?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(failed)?;
    rows.collect::<rusqlite::Result<_>>().map_err(failed)
}

/// Saves a preference, or removes it when `value` is null.
#[tauri::command]
pub fn preferences_set(key: String, value: Option<String>) -> Result<(), String> {
    checked_preference(&key, value.as_deref())?;
    let connection = settings_db();
    let result = match value {
        Some(value) => connection.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)", params![key, value]),
        None => connection.execute("DELETE FROM preferences WHERE key = ?1", [&key]),
    };
    result.map(|_| ()).map_err(|error| format!("Cannot save {key}: {error}"))
}

/// Brings over what the webview's local storage held; preferences already saved win.
#[tauri::command]
pub fn preferences_import(entries: HashMap<String, String>) -> Result<usize, String> {
    let mut connection = settings_db();
    let failed = |error: rusqlite::Error| format!("Cannot import preferences: {error}");
    let transaction = connection.transaction().map_err(failed)?;
    let mut imported = 0;
    for (key, value) in &entries {
        if checked_preference(key, Some(value)).is_ok() {
            imported += transaction.execute("INSERT OR IGNORE INTO preferences (key, value) VALUES (?1, ?2)", params![key, value]).map_err(failed)?;
        }
    }
    transaction.commit().map_err(failed)?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_files_are_imported_once_and_removed() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("server.json"), r#"{"enabled":true,"port":7865,"token":"0123456789abcdef0123"}"#).unwrap();
        fs::write(folder.path().join("tray.json"), r#"{"minimizeToTray":false}"#).unwrap();
        fs::write(folder.path().join("immich.json"), "not json").unwrap();
        fs::write(folder.path().join("stores.json"), r#"{"stores":[{"id":"a","name":"One","path":"/one"},{"id":"b","name":"Two","path":"/two","immich":true,"immichPath":"/data/upload/u"}]}"#).unwrap();
        let path = folder.path().join("inpaint.db");
        let mut connection = open(&path, true).unwrap();
        migrate_settings(&mut connection, folder.path()).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let value: String = connection.query_row("SELECT value FROM settings WHERE key = 'server'", [], |row| row.get(0)).unwrap();
        assert!(value.contains("0123456789abcdef0123"));
        assert!(!folder.path().join("server.json").exists() && !folder.path().join("tray.json").exists() && !folder.path().join("stores.json").exists());
        assert!(folder.path().join("immich.json").exists(), "an unreadable file is kept");
        let stores: Vec<(String, i64, bool)> = connection
            .prepare("SELECT id, position, immich FROM stores ORDER BY position").unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
            .collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(stores, [("a".to_string(), 0, false), ("b".to_string(), 1, true)]);
        // A second start imports nothing again.
        fs::write(folder.path().join("tray.json"), r#"{"minimizeToTray":true}"#).unwrap();
        migrate_settings(&mut connection, folder.path()).unwrap();
        assert!(folder.path().join("tray.json").exists());
    }

    #[test]
    fn cache_imports_old_indexes_and_thumbnails() {
        let folder = tempfile::tempdir().unwrap();
        fs::create_dir_all(folder.path().join(".cache/stores")).unwrap();
        fs::create_dir_all(folder.path().join(".cache/thumbnails")).unwrap();
        fs::write(
            folder.path().join(".cache/stores/s1.json"),
            r#"{"images":[{"name":"abcd.jpg","path":"/s/ab/cd/abcd.jpg","extension":"jpg","size":10,"modifiedMs":5}],"stats":{"pictures":1,"bytes":10,"otherFiles":2,"scannedMs":9,"scanSeconds":1.5}}"#,
        )
        .unwrap();
        fs::write(folder.path().join(".cache/thumbnails/0011.jpg"), [0u8; 42]).unwrap();
        let mut connection = open(&folder.path().join(".cache/cache.db"), false).unwrap();
        migrate_cache(&mut connection, folder.path()).unwrap();
        let contents = super::super::stores::read_index(&connection, "s1").unwrap().unwrap();
        assert_eq!(serde_json::to_value(&contents).unwrap()["stats"], serde_json::json!({ "pictures": 1, "bytes": 10, "otherFiles": 2, "scannedMs": 9, "scanSeconds": 1.5 }));
        let bytes: i64 = connection.query_row("SELECT bytes FROM thumbnails WHERE file = '0011.jpg'", [], |row| row.get(0)).unwrap();
        assert_eq!(bytes, 42);
        assert!(!folder.path().join(".cache/stores").exists());
    }

    #[test]
    fn preferences_keep_their_text_and_imports_do_not_overwrite() {
        preferences_set("inpaint.brushSize".into(), Some("54".into())).unwrap();
        let imported = preferences_import(HashMap::from([("inpaint.brushSize".into(), "12".into()), ("inpaint.model".into(), "lama".into()), ("other".into(), "x".into())])).unwrap();
        assert_eq!(imported, 1);
        let all = preferences_all().unwrap();
        assert_eq!((all["inpaint.brushSize"].as_str(), all["inpaint.model"].as_str(), all.contains_key("other")), ("54", "lama", false));
        preferences_set("inpaint.model".into(), None).unwrap();
        assert!(!preferences_all().unwrap().contains_key("inpaint.model"));
        assert!(preferences_set("notours".into(), Some("1".into())).is_err());
    }
}
