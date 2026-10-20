//! Duplicate pictures of a store, found the way TinEye finds copies: resized, recompressed, retouched
//! or cropped pictures count as copies of the one they came from.
//!
//! The search runs `duplicates.py` in its own Python process rather than the model worker, so the editor
//! stays usable during a search that takes minutes on a large store. The script keeps its
//! embeddings in `.cache/duplicates/<store>.npz` and checked pairs in its SQLite sidecar; the
//! groups it found are kept beside it as `<store>.json` and shown when the store opens again.

use super::{db, project_dir, python_executable, runtime, stores};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const DUPLICATES_SCRIPT: &str = include_str!("../../backend/duplicates.py");

/// The stop file of each search that is running, by store.
static RUNNING: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePicture {
    pub(crate) path: String,
    width: u32,
    height: u32,
    size: u64,
    modified_ms: u128,
}

impl DuplicatePicture {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let unchanged = fs::metadata(&self.path).is_ok_and(|metadata| metadata.is_file()
            && metadata.len() == self.size && stores::modified_ms(&metadata) == self.modified_ms);
        if unchanged { Ok(()) } else { Err(format!("{} changed or disappeared since the duplicate search. Search again before deleting.", self.path)) }
    }
}

/// Recheck both the copies to delete and those being kept before transferring metadata.
#[tauri::command]
pub fn duplicates_validate(pictures: Vec<DuplicatePicture>) -> Result<(), String> {
    for picture in pictures { picture.validate()?; }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pictures: Vec<DuplicatePicture>,
    similarity: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Duplicates {
    groups: Vec<DuplicateGroup>,
    /// Pictures compared, and pictures that could not be read.
    pictures: usize,
    unreadable: usize,
    level: String,
    searched_ms: u128,
    /// True for a running or interrupted search; confirmed groups are still safe to review.
    #[serde(default)]
    partial: bool,
}

fn read_result(path: &std::path::Path, level: &str) -> Result<Duplicates, String> {
    #[derive(Deserialize)]
    struct Found {
        groups: Vec<DuplicateGroup>,
        pictures: usize,
        unreadable: usize,
        partial: bool,
    }
    let found: Found = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Cannot read the duplicate search's answer: {error}"))?;
    let searched_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
    Ok(Duplicates { groups: found.groups, pictures: found.pictures, unreadable: found.unreadable,
        level: level.into(), searched_ms, partial: found.partial })
}

fn save_indexed_result(connection: &rusqlite::Connection, store_id: &str, saved: &std::path::Path, found: &mut Duplicates) -> Result<(), String> {
    retain_indexed(connection, store_id, found)?;
    let temporary = saved.with_extension("json.tmp");
    serde_json::to_vec(found).map_err(std::io::Error::other)
        .and_then(|bytes| fs::write(&temporary, bytes))
        .and_then(|_| fs::rename(&temporary, saved))
        .map_err(|error| format!("Cannot keep the duplicate search's answer: {error}"))
}

fn save_result(store_id: &str, found: &mut Duplicates) {
    let saved = folder().join(format!("{store_id}.json"));
    // Hold the cache lock across filtering and writing. Concurrent deletion cannot prune
    // a checkpoint only for an older worker snapshot to overwrite it with deleted files.
    let connection = db::cache_db();
    if let Err(error) = save_indexed_result(&connection, store_id, &saved, found) { eprintln!("{error}"); }
}

fn folder() -> PathBuf {
    project_dir().join(".cache/duplicates")
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|character| character.is_ascii_alphanumeric()) {
        return Err("Unknown store".into());
    }
    Ok(())
}

/// The groups found by the last search of the store, if it was searched.
#[tauri::command]
pub async fn duplicates_cached(store_id: String) -> Result<Option<Duplicates>, String> {
    valid_id(&store_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        match fs::read(folder().join(format!("{store_id}.json"))) {
            Ok(bytes) => {
                let Some(mut found) = serde_json::from_slice::<Duplicates>(&bytes).ok() else { return Ok(None) };
                // Store opening must not stat every file, especially on network mounts. The
                // background store scan and explicit duplicate search check the filesystem.
                retain_indexed(&db::cache_db(), &store_id, &mut found)?;
                Ok(Some(found))
            }
            Err(_) => Ok(None),
        }
    }).await.map_err(|error| error.to_string())?
}

fn retain_indexed(connection: &rusqlite::Connection, store_id: &str, found: &mut Duplicates) -> Result<(), String> {
    let mut statement = connection.prepare("SELECT 1 FROM store_pictures WHERE store_id = ?1 AND path = ?2")
        .map_err(|error| error.to_string())?;
    let mut paths = HashSet::new();
    for picture in found.groups.iter().flat_map(|group| &group.pictures) {
        if statement.exists(rusqlite::params![store_id, picture.path]).map_err(|error| error.to_string())? {
            paths.insert(picture.path.clone());
        }
    }
    retain_pictures(found, &paths);
    Ok(())
}

fn retain_pictures(found: &mut Duplicates, paths: &HashSet<String>) {
    for group in &mut found.groups {
        group.pictures.retain(|picture| paths.contains(&picture.path));
    }
    found.groups.retain(|group| group.pictures.len() > 1);
}

fn clear_result(store_id: &str) -> Result<(), String> {
    match fs::remove_file(folder().join(format!("{store_id}.json"))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot clear duplicate results: {error}")),
    }
}

/// Remove deleted members while preserving other confirmed groups, including live checkpoints.
/// A trashed Immich file still exists on disk, so filtering must use the store index.
pub(crate) fn invalidate_result(store_id: &str) {
    if valid_id(store_id).is_ok() {
        let connection = db::cache_db();
        let saved = folder().join(format!("{store_id}.json"));
        if let Ok(bytes) = fs::read(&saved) {
            if let Ok(mut found) = serde_json::from_slice::<Duplicates>(&bytes) {
                if let Err(error) = save_indexed_result(&connection, store_id, &saved, &mut found) { eprintln!("{error}"); }
            }
        }
    }
}

/// Clears the saved result, keeping embeddings for the next search.
#[tauri::command]
pub fn duplicates_clear(store_id: String) -> Result<(), String> {
    valid_id(&store_id)?;
    let running = RUNNING.lock().unwrap();
    if running.as_ref().is_some_and(|running| running.contains_key(&store_id)) {
        return Err("Stop the duplicate search before clearing its results.".into());
    }
    clear_result(&store_id)
}

/// Asks a running search to stop; it keeps what it read so far for the next one.
#[tauri::command]
pub fn duplicates_cancel(store_id: String) {
    if let Some(stop) = RUNNING.lock().unwrap().as_ref().and_then(|running| running.get(&store_id)) {
        let _ = fs::write(stop, b"");
    }
}

pub(crate) fn shutdown() {
    if let Some(running) = RUNNING.lock().unwrap().as_ref() {
        for stop in running.values() { let _ = fs::write(stop, b""); }
    }
}

/// Kill and reap on every error path; a blocked decoder must not make Stop ineffective.
struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn worker_answer(child: Child, stop: &std::path::Path, mut progress: impl FnMut(serde_json::Value)) -> Result<serde_json::Value, String> {
    let mut child = Worker(child);
    let stdout = child.0.stdout.take().ok_or("The duplicate search has no output pipe")?;
    let (send, receive) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() { break; }
        }
    });
    let mut answer = None;
    let mut stopping = None;
    loop {
        if stop.exists() && stopping.get_or_insert_with(Instant::now).elapsed() >= Duration::from_secs(2) {
            return Err("Stopped.".into());
        }
        match receive.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                let Some(payload) = line.strip_prefix("INPAINT_RPC:") else { continue };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { continue };
                if matches!(value["event"].as_str(), Some("progress" | "results")) { progress(value); }
                else if value.get("ok").is_some() { answer = Some(value); }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {},
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if child.0.try_wait().map_err(|error| error.to_string())?.is_some() { break; }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    if stop.exists() { return Err("Stopped.".into()); }
    answer.ok_or("The duplicate search stopped unexpectedly.".into())
}

/// Searches the store's indexed pictures for copies of each other. Progress arrives as
/// `duplicates-progress` with the stage (`model`, `embed`, `compare`, `verify`) and counts.
#[tauri::command]
pub async fn duplicates_search(app: AppHandle, state: tauri::State<'_, stores::StoresState>, store_id: String, level: String) -> Result<Duplicates, String> {
    valid_id(&store_id)?;
    if !matches!(level.as_str(), "close" | "normal" | "loose") {
        return Err("Choose how close the copies must be".into());
    }
    stores::find_store(&store_id)?;
    let work = tempfile::Builder::new().prefix("inpaint-duplicates-").tempdir().map_err(|error| error.to_string())?;
    let stop = work.path().join("stop");
    {
        let mut running = RUNNING.lock().unwrap();
        let running = running.get_or_insert_with(HashMap::new);
        if !running.is_empty() {
            return Err("A duplicate search is already running. Stop it before starting another.".into());
        }
        clear_result(&store_id)?;
        running.insert(store_id.clone(), stop.clone());
    }
    // The complete search counts as use, including folder scanning, model loading and
    // silent pair checks. Dropping the guard restores the idle timeout on every exit.
    let _activity = super::hidden::keep_active();
    let result = async {
        let _ = app.emit("duplicates-progress", json!({ "storeId": store_id, "stage": "scan", "done": 0, "total": 0 }));
        // A cached index can contain only files that were since emptied from Immich's trash.
        // Always discover the actual pictures before reusing any embeddings or pair verdicts.
        let contents = stores::store_scan(app.clone(), state, store_id.clone()).await?;
        let _ = app.emit("store-index-updated", json!({ "storeId": store_id, "contents": contents }));
        if stop.exists() { return Err("Stopped.".into()); }
        let id = store_id.clone();
        tauri::async_runtime::spawn_blocking(move || search(&app, &id, &level, contents, work.path(), &stop))
            .await.map_err(|error| error.to_string())?
    }.await;
    if let Some(running) = RUNNING.lock().unwrap().as_mut() {
        running.remove(&store_id);
    }
    result
}

fn search(app: &AppHandle, store_id: &str, level: &str, contents: stores::StoreContents, work: &std::path::Path, stop: &std::path::Path) -> Result<Duplicates, String> {
    let store = stores::find_store(store_id)?;
    let _ = app.emit("duplicates-progress", json!({ "storeId": store_id, "stage": "trash", "done": 0, "total": 0 }));
    let trashed = super::immich::trashed_paths(&store)?;
    if stop.exists() { return Err("Stopped.".into()); }
    let pictures: Vec<_> = contents.images.iter()
        .filter(|image| !trashed.contains(&image.path))
        .map(|image| json!({ "path": image.path, "size": image.size, "modifiedMs": image.modified_ms as u64 }))
        .collect();

    let models_dir = project_dir().join("models");
    let runtime_dir = models_dir.join(".runtime");
    fs::create_dir_all(&runtime_dir).map_err(|error| format!("Cannot create model runtime directory: {error}"))?;
    fs::write(runtime_dir.join("duplicates.py"), DUPLICATES_SCRIPT).map_err(|error| error.to_string())?;
    fs::write(runtime_dir.join("worker_protocol.py"), super::PROTOCOL_SCRIPT).map_err(|error| error.to_string())?;
    fs::create_dir_all(folder()).map_err(|error| error.to_string())?;

    let request_path = work.join("request.json");
    let output = work.join("output.json");
    let request = json!({
        "pictures": pictures,
        "cache": folder().join(format!("{store_id}.npz")),
        "output": output,
        "stop": stop,
        "level": level,
    });
    fs::write(&request_path, request.to_string()).map_err(|error| error.to_string())?;

    let mut command = Command::new(python_executable());
    runtime::clear_python_environment(&mut command);
    let child = command
        .arg(runtime_dir.join("duplicates.py"))
        .arg(&request_path)
        .current_dir(&runtime_dir)
        .env("XDG_CACHE_HOME", &models_dir)
        .env("TORCH_HOME", models_dir.join("torch"))
        .env("HF_HOME", models_dir.join("huggingface"))
        .env("HUGGINGFACE_HUB_CACHE", models_dir.join("huggingface/hub"))
        // Keep native math libraries from multiplying the bounded Python worker threads.
        .env("OMP_NUM_THREADS", "2")
        .env("MKL_NUM_THREADS", "2")
        .env("OPENBLAS_NUM_THREADS", "2")
        .env("INPAINT_DUPLICATES_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Cannot start the duplicate search: {error}"))?;
    let answer = worker_answer(child, stop, |value| {
        if value["event"] == "results" {
            match read_result(&output, level) {
                Ok(mut found) => {
                    save_result(store_id, &mut found);
                    let _ = app.emit("duplicates-results", json!({ "storeId": store_id, "result": found }));
                }
                Err(error) => eprintln!("{error}"),
            }
        } else {
            let _ = app.emit("duplicates-progress", json!({
                "storeId": store_id, "stage": value["stage"], "done": value["done"], "total": value["total"],
                "picturesDone": value["picturesDone"], "picturesTotal": value["picturesTotal"],
            }));
        }
    })?;
    if answer["ok"].as_bool() != Some(true) {
        let error = answer["error"].as_str().unwrap_or("The duplicate search failed.");
        return Err(if error == "cancelled" { "Stopped.".into() } else { error.to_string() });
    }

    let mut duplicates = read_result(&output, level)?;
    // Deletions or a store rescan may have finished while the search was running.
    retain_indexed(&db::cache_db(), store_id, &mut duplicates)?;
    let paths = duplicates.groups.iter().flat_map(|group| &group.pictures)
        .filter(|picture| std::path::Path::new(&picture.path).is_file()).map(|picture| picture.path.clone()).collect();
    retain_pictures(&mut duplicates, &paths);
    save_result(store_id, &mut duplicates);
    Ok(duplicates)
}

/// Removes what the searches of a store kept, when the store itself is removed.
pub fn forget_store(store_id: &str) {
    if valid_id(store_id).is_err() {
        return;
    }
    duplicates_cancel(store_id.to_owned());
    for extension in ["json", "npz", "npz.pairs.sqlite3", "npz.pairs.sqlite3-journal"] {
        let _ = fs::remove_file(folder().join(format!("{store_id}.{extension}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_or_missing_pictures_cannot_be_used_for_duplicate_deletion() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("picture.png");
        fs::write(&path, b"original").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let picture = DuplicatePicture { path: path.to_string_lossy().into(), width: 10, height: 10,
            size: metadata.len(), modified_ms: stores::modified_ms(&metadata) };
        picture.validate().unwrap();
        fs::write(&path, b"edited picture").unwrap();
        assert!(picture.validate().unwrap_err().contains("changed or disappeared"));
        fs::remove_file(&path).unwrap();
        assert!(picture.validate().is_err());
    }

    #[test]
    fn old_results_without_file_versions_are_not_reused() {
        assert!(serde_json::from_value::<DuplicatePicture>(json!({"path":"old.png", "width":10, "height":10})).is_err());
    }

    #[test]
    fn worker_protocol_preserves_progress_results_and_the_final_answer() {
        let folder = tempfile::tempdir().unwrap();
        let child = Command::new("printf").args(["%s\n", "INPAINT_RPC:{\"event\":\"progress\",\"done\":1}",
            "INPAINT_RPC:{\"event\":\"results\"}", "INPAINT_RPC:{\"ok\":true}"])
            .stdout(Stdio::piped()).spawn().unwrap();
        let mut messages = Vec::new();
        let answer = worker_answer(child, &folder.path().join("stop"), |value| messages.push(value)).unwrap();
        assert_eq!(answer["ok"], true);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["done"], 1);
        assert_eq!(messages[1]["event"], "results");
    }

    #[test]
    fn snapshots_keep_their_partial_status_when_cached() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("output.json");
        fs::write(&path, br#"{"groups":[],"pictures":43000,"unreadable":2,"partial":true}"#).unwrap();
        let found = read_result(&path, "loose").unwrap();
        assert!(found.partial);
        assert_eq!(found.pictures, 43000);
        assert_eq!(found.level, "loose");
        let bytes = serde_json::to_vec(&found).unwrap();
        assert!(serde_json::from_slice::<Duplicates>(&bytes).unwrap().partial);
        // Existing completed results predate the partial flag.
        let mut old = serde_json::to_value(&found).unwrap();
        old.as_object_mut().unwrap().remove("partial");
        assert!(!serde_json::from_value::<Duplicates>(old).unwrap().partial);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stop_kills_and_reaps_a_worker_even_when_it_is_silent_or_closed_its_pipe() {
        let folder = tempfile::tempdir().unwrap();
        let stop = folder.path().join("stop");
        fs::write(&stop, b"").unwrap();
        for script in ["exec sleep 30", "exec 1>&-; exec sleep 30"] {
            let child = Command::new("sh").args(["-c", script]).stdout(Stdio::piped()).spawn().unwrap();
            let pid = child.id();
            let started = Instant::now();
            assert_eq!(worker_answer(child, &stop, |_| {}).unwrap_err(), "Stopped.");
            assert!(started.elapsed() < Duration::from_secs(5));
            assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        }
    }

    #[test]
    fn cached_groups_follow_the_store_index_without_opening_picture_files() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(db::CACHE_SCHEMA).unwrap();
        for (store, path) in [("first", "/not-mounted/a.jpg"), ("first", "/not-mounted/b.jpg"), ("second", "/not-mounted/c.jpg")] {
            connection.execute("INSERT INTO store_pictures (store_id, path, name, extension, size, modified_ms) VALUES (?1, ?2, '', 'jpg', 1, 0)", rusqlite::params![store, path]).unwrap();
        }
        let mut found = Duplicates {
            groups: vec![DuplicateGroup {
                pictures: ["/not-mounted/a.jpg", "/not-mounted/b.jpg", "/not-mounted/c.jpg"].into_iter()
                    .map(|path| DuplicatePicture { path: path.into(), width: 100, height: 100, size: 1, modified_ms: 0 }).collect(),
                similarity: 0.9,
            }],
            pictures: 3, unreadable: 0, level: "normal".into(), searched_ms: 0, partial: false,
        };
        retain_indexed(&connection, "first", &mut found).unwrap();
        assert_eq!(found.groups[0].pictures.len(), 2);
        connection.execute("DELETE FROM store_pictures WHERE path = '/not-mounted/a.jpg'", []).unwrap();
        retain_indexed(&connection, "first", &mut found).unwrap();
        assert!(found.groups.is_empty());
    }

    #[test]
    fn deleted_members_and_resolved_groups_are_removed() {
        let group = |paths: &[&str]| DuplicateGroup {
            pictures: paths.iter().map(|path| DuplicatePicture { path: (*path).into(), width: 100, height: 100, size: 1, modified_ms: 0 }).collect(),
            similarity: 0.9,
        };
        let mut found = Duplicates {
            groups: vec![group(&["a", "b", "c"]), group(&["d", "e"])],
            pictures: 5, unreadable: 0, level: "normal".into(), searched_ms: 0, partial: false,
        };
        retain_pictures(&mut found, &HashSet::from(["a".into(), "c".into(), "d".into()]));
        assert_eq!(found.groups.len(), 1);
        assert_eq!(found.groups[0].pictures.iter().map(|picture| picture.path.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        retain_pictures(&mut found, &HashSet::new());
        assert!(found.groups.is_empty());
    }

    #[test]
    fn late_checkpoints_exclude_deleted_members_and_preserve_other_groups() {
        let folder = tempfile::tempdir().unwrap();
        let saved = folder.path().join("result.json");
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(db::CACHE_SCHEMA).unwrap();
        for path in ["a", "b", "c", "d", "e"] {
            connection.execute("INSERT INTO store_pictures (store_id, path, name, extension, size, modified_ms) VALUES ('store', ?1, '', 'jpg', 1, 0)", [path]).unwrap();
        }
        let group = |paths: &[&str]| DuplicateGroup {
            pictures: paths.iter().map(|path| DuplicatePicture { path: (*path).into(), width: 10, height: 10, size: 1, modified_ms: 0 }).collect(),
            similarity: 0.9,
        };
        let stale = Duplicates { groups: vec![group(&["a", "b", "c"]), group(&["d", "e"])],
            pictures: 5, unreadable: 0, level: "loose".into(), searched_ms: 0, partial: true };
        save_indexed_result(&connection, "store", &saved, &mut stale.clone()).unwrap();
        connection.execute("DELETE FROM store_pictures WHERE path = 'b'", []).unwrap();
        // Both pruning an existing checkpoint and saving a later stale snapshot must agree.
        let mut previous: Duplicates = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
        save_indexed_result(&connection, "store", &saved, &mut previous).unwrap();
        save_indexed_result(&connection, "store", &saved, &mut stale.clone()).unwrap();
        let kept: Duplicates = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
        assert!(kept.partial);
        assert_eq!(kept.groups.len(), 2);
        assert_eq!(kept.groups[0].pictures.iter().map(|picture| picture.path.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(kept.groups[1].pictures.len(), 2);
    }
}
