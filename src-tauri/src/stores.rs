//! Image stores: registered folders whose pictures are laid out like Immich's upload folders,
//! `ab/cd/abcd….ext`, each file two folders deep under the first four characters of its name.
//!
//! The registry is the `stores` table of `inpaint.db`. Opening a store shows its index from `cache.db`
//! at once while a rescan runs in the background; saving, dropping and deleting pictures keep the index
//! current in between. A scan reads the top folders in parallel, which on a network share is several
//! times faster than walking them one by one.

use super::{db, ImageEntry};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const SCAN_THREADS: usize = 32;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub id: String,
    pub name: String,
    pub path: String,
    /// After the editor saves one of its pictures, ask Immich to rebuild the thumbnail.
    pub immich: bool,
    /// The store folder as Immich sees it, such as /data/upload/<user id>.
    pub immich_path: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pictures: u64,
    bytes: u64,
    /// Files in the store that are not listed: videos, sidecars, and names outside the layout.
    other_files: u64,
    scanned_ms: u128,
    scan_seconds: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreContents {
    images: Vec<ImageEntry>,
    stats: StoreStats,
}

#[derive(Default)]
pub struct StoresState {
    scanning: Mutex<HashSet<String>>,
}

const STORE_COLUMNS: &str = "id, name, path, immich, immich_path";

fn read_store(row: &rusqlite::Row) -> rusqlite::Result<Store> {
    Ok(Store { id: row.get(0)?, name: row.get(1)?, path: row.get(2)?, immich: row.get(3)?, immich_path: row.get(4)? })
}

/// Adds a store to the registry at `position`; a store with the same id or folder is kept.
pub(crate) fn insert(connection: &Connection, store: &Store, position: i64) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT OR IGNORE INTO stores (id, position, name, path, immich, immich_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![store.id, position, store.name, store.path, store.immich, store.immich_path],
    )
}

fn new_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the system random number generator is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn database_error(error: rusqlite::Error) -> String {
    format!("Cannot use the store registry: {error}")
}

pub fn find_store(id: &str) -> Result<Store, String> {
    db::settings_db()
        .query_row(&format!("SELECT {STORE_COLUMNS} FROM stores WHERE id = ?1"), [id], read_store)
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| "This store no longer exists.".into())
}

/// Stores marked Immich compatible, for refreshing Immich after a save.
pub fn immich_stores() -> Vec<Store> {
    stores_list().into_iter().filter(|store| store.immich).collect()
}

#[tauri::command]
pub fn stores_list() -> Vec<Store> {
    let connection = db::settings_db();
    let stores = connection
        .prepare(&format!("SELECT {STORE_COLUMNS} FROM stores ORDER BY position"))
        .and_then(|mut statement| statement.query_map([], read_store)?.collect::<rusqlite::Result<Vec<_>>>());
    stores.unwrap_or_else(|error| {
        eprintln!("Cannot list image stores: {error}");
        Vec::new()
    })
}

#[tauri::command]
pub fn store_create(app: AppHandle, name: String, path: String) -> Result<Store, String> {
    let store = create(name, path)?;
    super::dropbox::refresh(&app);
    Ok(store)
}

pub fn create(name: String, path: String) -> Result<Store, String> {
    let folder = fs::canonicalize(&path).map_err(|error| format!("Cannot open {path}: {error}"))?;
    if !folder.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    let folder_text = super::path_string(&folder);
    let connection = db::settings_db();
    let existing: Option<String> = connection
        .query_row("SELECT name FROM stores WHERE path = ?1", [&folder_text], |row| row.get(0))
        .optional()
        .map_err(database_error)?;
    if let Some(existing) = existing {
        return Err(format!("{folder_text} is already the store \"{existing}\"."));
    }
    let name = match name.trim() {
        "" => folder.file_name().map_or_else(|| "Store".into(), |name| name.to_string_lossy().into_owned()),
        name => name.to_string(),
    };
    let store = Store { id: new_id(), name, path: folder_text, ..Default::default() };
    let position: i64 = connection.query_row("SELECT COALESCE(MAX(position) + 1, 0) FROM stores", [], |row| row.get(0)).map_err(database_error)?;
    insert(&connection, &store, position).map_err(database_error)?;
    Ok(store)
}

/// Saves the name and Immich settings; the folder of a store never changes.
#[tauri::command]
pub fn store_update(app: AppHandle, store: Store) -> Result<Store, String> {
    let name = store.name.trim();
    if name.is_empty() {
        return Err("Give the store a name.".into());
    }
    let immich_path = store.immich_path.trim().trim_end_matches('/').to_string();
    if store.immich && !immich_path.starts_with('/') {
        return Err("Enter the folder as Immich sees it, such as /data/upload/<user id>.".into());
    }
    let changed = db::settings_db()
        .execute("UPDATE stores SET name = ?1, immich = ?2, immich_path = ?3 WHERE id = ?4", params![name, store.immich, immich_path, store.id])
        .map_err(database_error)?;
    if changed == 0 {
        return Err("This store no longer exists.".into());
    }
    let updated = find_store(&store.id)?;
    super::dropbox::refresh(&app);
    Ok(updated)
}

/// Forgets a store. Its folder and pictures stay on disk.
#[tauri::command]
pub fn store_remove(app: AppHandle, id: String) -> Result<(), String> {
    db::settings_db().execute("DELETE FROM stores WHERE id = ?1", [&id]).map_err(database_error)?;
    let cache = db::cache_db();
    let _ = cache.execute("DELETE FROM store_pictures WHERE store_id = ?1", [&id]);
    let _ = cache.execute("DELETE FROM store_scans WHERE store_id = ?1", [&id]);
    drop(cache);
    super::dropbox::refresh(&app);
    Ok(())
}

/// Replaces a store's index with a scan's result. Callers wrap it in a transaction.
pub(crate) fn write_index(connection: &Connection, id: &str, contents: &StoreContents) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM store_pictures WHERE store_id = ?1", [id])?;
    let mut insert = connection.prepare_cached(
        "INSERT OR REPLACE INTO store_pictures (store_id, path, name, extension, size, modified_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for image in &contents.images {
        insert.execute(params![id, image.path, image.name, image.extension, image.size as i64, image.modified_ms as i64])?;
    }
    let stats = &contents.stats;
    connection.execute(
        "INSERT OR REPLACE INTO store_scans (store_id, other_files, scanned_ms, scan_seconds) VALUES (?1, ?2, ?3, ?4)",
        params![id, stats.other_files as i64, stats.scanned_ms as i64, stats.scan_seconds],
    )?;
    Ok(())
}

/// A store's index, newest pictures first; None before its first scan.
pub(crate) fn read_index(connection: &Connection, id: &str) -> rusqlite::Result<Option<StoreContents>> {
    let Some((other_files, scanned_ms, scan_seconds)) = connection
        .query_row("SELECT other_files, scanned_ms, scan_seconds FROM store_scans WHERE store_id = ?1", [id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, f64>(2)?))
        })
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = connection.prepare("SELECT name, path, extension, size, modified_ms FROM store_pictures WHERE store_id = ?1 ORDER BY modified_ms DESC, name")?;
    let images: Vec<ImageEntry> = statement
        .query_map([id], |row| {
            Ok(ImageEntry {
                name: row.get(0)?,
                path: row.get(1)?,
                extension: row.get(2)?,
                size: row.get::<_, i64>(3)? as u64,
                modified_ms: row.get::<_, i64>(4)? as u128,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let stats = StoreStats {
        pictures: images.len() as u64,
        bytes: images.iter().map(|image| image.size).sum(),
        other_files: other_files as u64,
        scanned_ms: scanned_ms as u128,
        scan_seconds,
    };
    Ok(Some(StoreContents { images, stats }))
}

/// The index saved by the last scan, if any.
#[tauri::command]
pub async fn store_cached(id: String) -> Result<Option<StoreContents>, String> {
    tauri::async_runtime::spawn_blocking(move || read_index(&db::cache_db(), &id).map_err(|error| format!("Cannot read the store index: {error}")))
        .await
        .map_err(|error| error.to_string())?
}

/// Scans the store folder, saves the index and returns it. Progress arrives as `store-scan`.
#[tauri::command]
pub async fn store_scan(app: AppHandle, state: tauri::State<'_, StoresState>, id: String) -> Result<StoreContents, String> {
    let store = find_store(&id)?;
    if !state.scanning.lock().unwrap().insert(id.clone()) {
        return Err("This store is already being scanned.".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let contents = scan(Path::new(&store.path), |done, total| {
            let _ = app.emit("store-scan", json!({ "id": store.id, "done": done, "total": total }));
        })?;
        let failed = |error: rusqlite::Error| format!("Cannot save the store index: {error}");
        let mut connection = db::cache_db();
        let transaction = connection.transaction().map_err(failed)?;
        write_index(&transaction, &store.id, &contents).map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(contents)
    })
    .await;
    state.scanning.lock().unwrap().remove(&id);
    result.map_err(|error| error.to_string())?
}

/// Adds or updates a picture in its store's index after it was saved or dropped, until the next scan.
/// Pictures outside stores, outside the layout, or in stores never scanned are left alone.
pub fn record_picture(path: &Path) {
    let Some(store) = stores_list().into_iter().find(|store| path.starts_with(&store.path)) else { return };
    let Some(image) = super::image_entry(path) else { return };
    let relative: Vec<String> = path.strip_prefix(&store.path).map(|relative| relative.iter().map(|part| part.to_string_lossy().into_owned()).collect()).unwrap_or_default();
    let [first, second, file] = relative.as_slice() else { return };
    if !is_hex_pair(first) || !is_hex_pair(second) || layout_extension(first, second, file).is_none() {
        return;
    }
    let result = db::cache_db().execute(
        "INSERT OR REPLACE INTO store_pictures (store_id, path, name, extension, size, modified_ms)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM store_scans WHERE store_id = ?1)",
        params![store.id, image.path, image.name, image.extension, image.size as i64, image.modified_ms as i64],
    );
    if let Err(error) = result {
        eprintln!("Cannot update the store index: {error}");
    }
}

/// Removes a deleted picture from every store index.
pub fn forget_picture(path: &Path) {
    if let Err(error) = db::cache_db().execute("DELETE FROM store_pictures WHERE path = ?1", [super::path_string(path)]) {
        eprintln!("Cannot update the store index: {error}");
    }
}

fn is_hex_pair(name: &str) -> bool {
    name.len() == 2 && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The picture extension of a file that fits the layout: its name starts with both folder names.
fn layout_extension(first: &str, second: &str, file: &str) -> Option<String> {
    let lower = file.to_ascii_lowercase();
    if lower.as_bytes().get(..4) != Some(format!("{first}{second}").as_bytes()) {
        return None;
    }
    super::picture_extension(Path::new(&lower))
}

pub fn modified_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis())
}

fn scan(root: &Path, progress: impl Fn(usize, usize) + Sync) -> Result<StoreContents, String> {
    let started = Instant::now();
    let tops: Vec<String> = fs::read_dir(root)
        .map_err(|error| format!("Cannot open {}: {error}", root.display()))?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_hex_pair(name))
        .collect();
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let found = Mutex::new((Vec::new(), 0u64));
    std::thread::scope(|scope| {
        for _ in 0..SCAN_THREADS.min(tops.len()) {
            scope.spawn(|| loop {
                let Some(first) = tops.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
                let (images, others) = scan_top_folder(root, first);
                {
                    let mut found = found.lock().unwrap();
                    found.0.extend(images);
                    found.1 += others;
                }
                progress(done.fetch_add(1, Ordering::SeqCst) + 1, tops.len());
            });
        }
    });
    let (mut images, other_files) = found.into_inner().unwrap();
    images.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    let stats = StoreStats {
        pictures: images.len() as u64,
        bytes: images.iter().map(|image| image.size).sum(),
        other_files,
        scanned_ms: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_millis()),
        scan_seconds: started.elapsed().as_secs_f64(),
    };
    Ok(StoreContents { images, stats })
}

// Unreadable folders are skipped, so one bad folder does not hide the rest of the store.
fn scan_top_folder(root: &Path, first: &str) -> (Vec<ImageEntry>, u64) {
    let mut images = Vec::new();
    let mut others = 0;
    let Ok(seconds) = fs::read_dir(root.join(first)) else { return (images, others) };
    for second in seconds.flatten() {
        let Ok(second_name) = second.file_name().into_string() else { continue };
        if !is_hex_pair(&second_name) || !second.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(second.path()) else { continue };
        for file in files.flatten() {
            if !file.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let name = file.file_name().to_string_lossy().into_owned();
            let Some(extension) = layout_extension(first, &second_name, &name) else {
                others += 1;
                continue;
            };
            let Ok(metadata) = file.metadata() else { continue };
            images.push(ImageEntry {
                name,
                path: super::path_string(&file.path()),
                extension,
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }
    }
    (images, others)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn touch(root: &Path, relative: &str, age_seconds: u64) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, relative.as_bytes()).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age_seconds)).unwrap();
    }

    #[test]
    fn layout_accepts_hash_and_immich_names() {
        assert_eq!(layout_extension("ab", "cd", "abcdef0123.jpg").as_deref(), Some("jpg"));
        assert_eq!(layout_extension("f1", "ce", "f1cea150-f25f-436e-bdc4-262d26b6264e.JPG").as_deref(), Some("jpg"));
        assert_eq!(layout_extension("ab", "cd", "abce0000.png"), None);
        assert_eq!(layout_extension("ab", "cd", "abcd0000.mp4"), None);
        assert_eq!(layout_extension("ab", "cd", "abcd0000.jpg.xmp"), None);
        assert_eq!(layout_extension("ab", "cd", "ab"), None);
        assert!(is_hex_pair("0f") && !is_hex_pair("0F") && !is_hex_pair("thumbs") && !is_hex_pair("g0"));
    }

    #[test]
    fn scan_lists_layout_pictures_newest_first() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "ab/cd/abcd-old.jpg", 300);
        touch(root.path(), "ab/cd/abcd-new.webp", 10);
        touch(root.path(), "12/34/1234-middle.gif", 100);
        touch(root.path(), "ab/cd/abcd-old.jpg.xmp", 5);
        touch(root.path(), "ab/cd/ffff-elsewhere.png", 5);
        touch(root.path(), "ab/cd/abcd-clip.mp4", 5);
        touch(root.path(), "ab/loose.jpg", 5);
        touch(root.path(), "thumbs/ab/cd/abcd-thumb.jpg", 1);
        let progress = Mutex::new(Vec::new());
        let contents = scan(root.path(), |done, total| progress.lock().unwrap().push((done, total))).unwrap();
        let names: Vec<_> = contents.images.iter().map(|image| image.name.as_str()).collect();
        assert_eq!(names, ["abcd-new.webp", "1234-middle.gif", "abcd-old.jpg"]);
        assert_eq!(contents.stats.pictures, 3);
        assert_eq!(contents.stats.other_files, 3);
        assert_eq!(contents.stats.bytes, contents.images.iter().map(|image| image.size).sum::<u64>());
        assert_eq!(progress.into_inner().unwrap().len(), 2);
    }

    #[test]
    fn index_round_trips_through_the_cache_database() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "ab/cd/abcd-old.jpg", 300);
        touch(root.path(), "ab/cd/abcd-new.webp", 10);
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(db::CACHE_SCHEMA).unwrap();
        assert!(read_index(&connection, "s").unwrap().is_none());
        let contents = scan(root.path(), |_, _| {}).unwrap();
        let transaction = connection.transaction().unwrap();
        write_index(&transaction, "s", &contents).unwrap();
        transaction.commit().unwrap();
        let read = read_index(&connection, "s").unwrap().unwrap();
        assert_eq!(serde_json::to_value(&read).unwrap(), serde_json::to_value(&contents).unwrap());
        // A rescan replaces the rows rather than adding to them.
        write_index(&connection, "s", &contents).unwrap();
        assert_eq!(read_index(&connection, "s").unwrap().unwrap().images.len(), 2);
    }

    // INPAINT_TEST_STORE=/mnt/Immich/upload/<user> cargo test real_store -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_store() {
        let path = std::env::var("INPAINT_TEST_STORE").expect("set INPAINT_TEST_STORE");
        let contents = scan(Path::new(&path), |_, _| {}).unwrap();
        println!("{} pictures, {} bytes, {} other files in {:.1}s", contents.stats.pictures, contents.stats.bytes, contents.stats.other_files, contents.stats.scan_seconds);
    }
}
