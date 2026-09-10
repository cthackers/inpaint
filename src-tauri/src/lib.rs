use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Condvar, LazyLock, Mutex},
};
use tempfile::Builder;
use tauri::{Emitter, Manager};
mod db;
mod dropbox;
mod http;
mod immich;
mod runtime;
mod server;
mod stores;
mod tray;
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

const INPAINT_SCRIPT: &str = include_str!("../../backend/inpaint.py");
const FACE_SWAP_SCRIPT: &str = include_str!("../../backend/face_swap.py");
const RESTORE_SCRIPT: &str = include_str!("../../backend/restore.py");
const RESTORMER_SCRIPT: &str = include_str!("../../backend/restormer.py");
const RESTORMER_ARCH_SCRIPT: &str = include_str!("../../backend/restormer_arch.py");
const UPSCALE_SCRIPT: &str = include_str!("../../backend/upscale.py");
const EDITING_SCRIPT: &str = include_str!("../../backend/editing.py");
const ADVANCED_SCRIPT: &str = include_str!("../../backend/advanced.py");
const DOWNLOADS_SCRIPT: &str = include_str!("../../backend/downloads.py");
const PROTOCOL_SCRIPT: &str = include_str!("../../backend/worker_protocol.py");

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageEntry {
    name: String,
    path: String,
    extension: String,
    size: u64,
    modified_ms: u128,
}

#[derive(Serialize)]
struct FolderEntry {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct DirectoryContents {
    folders: Vec<FolderEntry>,
    images: Vec<ImageEntry>,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn project_dir() -> PathBuf {
    if let Some(configured) = std::env::var_os("INPAINT_PROJECT_DIR") {
        let path = PathBuf::from(configured);
        return path;
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            if parent.join(".venv").is_dir() || parent.join("models").is_dir() {
                return parent.to_path_buf();
            }
        }
    }

    #[cfg(debug_assertions)]
    if let Ok(current) = std::env::current_dir() {
        if current.join(".venv").is_dir() || current.join("models").is_dir() {
            return current;
        }
    }

    std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir).join("inpaint-desktop")
}

fn folder_entry(path: PathBuf) -> FolderEntry {
    FolderEntry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_string(&path)),
        path: path_string(&path),
    }
}

fn image_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp").then_some(extension)
}

/// Pictures the browser lists and the editor opens. GIF, BMP and TIFF open as PNG and cannot be
/// written back, unlike the formats of `image_extension`.
fn picture_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff").then_some(extension)
}

#[tauri::command]
fn list_folders(path: String) -> Result<Vec<FolderEntry>, String> {
    let mut folders = Vec::new();
    let entries = fs::read_dir(&path).map_err(|error| format!("Cannot open {path}: {error}"))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            folders.push(folder_entry(entry_path));
        }
    }
    folders.sort_by_key(|folder| folder.name.to_ascii_lowercase());
    Ok(folders)
}

#[tauri::command]
fn list_directory(path: String) -> Result<DirectoryContents, String> {
    let mut folders = Vec::new();
    let mut images = Vec::new();
    let entries = fs::read_dir(&path).map_err(|error| format!("Cannot open {path}: {error}"))?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            folders.push(folder_entry(entry_path));
        } else if file_type.is_file() {
            let Some(extension) = picture_extension(&entry_path) else { continue };
            let metadata = entry.metadata().ok();
            let modified_ms = metadata
                .as_ref()
                .and_then(|value| value.modified().ok())
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis())
                .unwrap_or(0);
            images.push(ImageEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path_string(&entry_path),
                extension,
                size: metadata.map(|value| value.len()).unwrap_or(0),
                modified_ms,
            });
        }
    }

    folders.sort_by_key(|folder| folder.name.to_ascii_lowercase());
    images.sort_by_key(|image| image.name.to_ascii_lowercase());
    Ok(DirectoryContents { folders, images })
}

fn mime_for(path: &Path) -> Result<&'static str, String> {
    match image_extension(path).as_deref() {
        Some("png") => Ok("image/png"),
        Some("jpg" | "jpeg") => Ok("image/jpeg"),
        Some("webp") => Ok("image/webp"),
        _ => Err("Only PNG, JPG, JPEG, and WebP images are supported".into()),
    }
}

fn decode_data_url(data: &str) -> Result<Vec<u8>, String> {
    let encoded = data
        .split_once(',')
        .map(|(_, payload)| payload)
        .ok_or_else(|| "Invalid image data".to_string())?;
    BASE64.decode(encoded).map_err(|error| format!("Invalid base64 image: {error}"))
}

#[tauri::command]
async fn read_image_data(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let data = fs::read(&path).map_err(|error| format!("Cannot read image: {error}"))?;
        if let Ok(mime) = mime_for(&path) {
            return Ok(format!("data:{mime};base64,{}", BASE64.encode(data)));
        }
        if picture_extension(&path).is_none() {
            return Err("Only PNG, JPG, WebP, GIF, BMP and TIFF images are supported".into());
        }
        // The editor works on formats the webview shows and Save writes; other pictures open as
        // PNG (a GIF as its first frame) and are saved as a new file.
        let image = image::load_from_memory(&data).map_err(|error| format!("Cannot decode image: {error}"))?;
        let png = encode_image(&image, ImageFormat::Png)?;
        Ok(format!("data:image/png;base64,{}", BASE64.encode(png)))
    })
    .await
    .map_err(|error| format!("Image task failed: {error}"))?
}

const THUMBNAIL_CACHE_LIMIT: u64 = 2 << 30;

fn thumbnail_cache_dir() -> PathBuf {
    project_dir().join(".cache/thumbnails")
}

/// Cached thumbnails are named after the picture's path, size and modification time, so an edited
/// picture gets a new thumbnail.
fn thumbnail_cache_file(path: &Path, metadata: &fs::Metadata) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata.modified().ok().hash(&mut hasher);
    thumbnail_cache_dir().join(format!("{:016x}.jpg", hasher.finish()))
}

/// Notes a cached thumbnail's size and last use in cache.db, which orders the cache for pruning.
fn thumbnail_used(file: &str, bytes: usize) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |time| time.as_millis() as i64);
    let result = db::cache_db().execute(
        "INSERT INTO thumbnails (file, bytes, last_used) VALUES (?1, ?2, ?3)
         ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes, last_used = excluded.last_used",
        rusqlite::params![file, bytes as i64, now],
    );
    if let Err(error) = result {
        eprintln!("Cannot note the thumbnail: {error}");
    }
}

/// Deletes the least recently used thumbnails while the cache is over its limit. Runs at startup and
/// after each new thumbnail.
fn prune_thumbnail_cache() {
    let connection = db::cache_db();
    let total: i64 = connection.query_row("SELECT COALESCE(SUM(bytes), 0) FROM thumbnails", [], |row| row.get(0)).unwrap_or(0);
    if total as u64 <= THUMBNAIL_CACHE_LIMIT {
        return;
    }
    let oldest: Vec<(String, i64)> = connection
        .prepare("SELECT file, bytes FROM thumbnails ORDER BY last_used")
        .and_then(|mut statement| statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect())
        .unwrap_or_default();
    let mut remaining = total as u64;
    for (file, bytes) in oldest {
        if remaining <= THUMBNAIL_CACHE_LIMIT / 10 * 8 {
            break;
        }
        let _ = fs::remove_file(thumbnail_cache_dir().join(&file));
        let _ = connection.execute("DELETE FROM thumbnails WHERE file = ?1", [&file]);
        remaining = remaining.saturating_sub(bytes as u64);
    }
}

/// A picture's thumbnail, a JPEG of at most 480×360, from the disk cache or made now.
fn thumbnail_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let extension = picture_extension(path).ok_or("Only PNG, JPG, WebP, GIF, BMP and TIFF images are supported")?;
    let metadata = fs::metadata(path).map_err(|error| format!("Cannot read image: {error}"))?;
    let cached = thumbnail_cache_file(path, &metadata);
    let file_name = cached.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    if let Ok(bytes) = fs::read(&cached) {
        thumbnail_used(&file_name, bytes.len());
        return Ok(bytes);
    }
    let thumbnail = THUMBNAIL_MAKERS.run(|| make_thumbnail(path, &extension))?;
    if fs::create_dir_all(thumbnail_cache_dir()).is_ok() && replace_file(&cached, &thumbnail).is_ok() {
        thumbnail_used(&file_name, thumbnail.len());
        prune_thumbnail_cache();
    }
    Ok(thumbnail)
}

#[tauri::command]
async fn read_thumbnail_data(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail_bytes(Path::new(&path)).map(|bytes| format!("data:image/jpeg;base64,{}", BASE64.encode(bytes))))
        .await
        .map_err(|error| format!("Thumbnail task failed: {error}"))?
}

/// Serves `thumb://localhost/<percent-encoded path>?v=<size>-<modified>`. The gallery loads thumbnails as
/// ordinary images, which the webview decodes off its main thread and caches; the query changes the
/// address whenever the picture changes, so a cached copy is never stale.
fn thumbnail_response(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/')).decode_utf8_lossy().into_owned();
    let response = tauri::http::Response::builder();
    match thumbnail_bytes(Path::new(&path)) {
        Ok(bytes) => response.header("Content-Type", "image/jpeg").header("Cache-Control", "max-age=31536000, immutable").body(bytes),
        Err(error) => response.status(404).header("Content-Type", "text/plain").body(error.into_bytes()),
    }
    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Limits how many thumbnails are made at once; cached ones never wait.
struct Workers {
    free: Mutex<usize>,
    released: Condvar,
}

struct Permit<'a>(&'a Workers);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.free.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        self.0.released.notify_one();
    }
}

impl Workers {
    fn run<T>(&self, work: impl FnOnce() -> T) -> T {
        let mut free = self.free.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *free == 0 {
            free = self.released.wait(free).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *free -= 1;
        drop(free);
        let _permit = Permit(self);
        work()
    }
}

// ImageMagick runs single-threaded per thumbnail, so this many processes use this many cores.
static THUMBNAIL_MAKERS: LazyLock<Workers> = LazyLock::new(|| Workers {
    free: Mutex::new(std::thread::available_parallelism().map_or(4, |cores| cores.get()).clamp(2, 16)),
    released: Condvar::new(),
});

fn make_thumbnail(path: &Path, extension: &str) -> Result<Vec<u8>, String> {
    // ImageMagick is heavily optimized even while this app is running as a
    // development build. Prefer it for previews; retain the image-crate
    // path so packaged builds still work when ImageMagick is unavailable.
    let mut source = path.as_os_str().to_owned();
    if matches!(extension, "gif" | "tif" | "tiff") {
        // Only the first frame or page.
        source.push("[0]");
    }
    if let Ok(result) = Command::new("magick")
        .env("MAGICK_THREAD_LIMIT", "1")
        .args(["-define", "jpeg:size=960x720"])
        .arg(&source)
        .args([
            "-auto-orient",
            "-thumbnail",
            "480x360>",
            "-strip",
            "-quality",
            "82",
            "jpeg:-",
        ])
        .output()
    {
        if result.status.success() && !result.stdout.is_empty() {
            return Ok(result.stdout);
        }
    }

    let image = image::open(path)
        .map_err(|error| format!("Cannot decode thumbnail: {error}"))?;
    let thumbnail = image.thumbnail(480, 360).to_rgb8();
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 82)
        .encode_image(&thumbnail)
        .map_err(|error| format!("Cannot encode thumbnail: {error}"))?;
    Ok(output)
}

fn image_format_for(path: &Path) -> Result<ImageFormat, String> {
    match image_extension(path).as_deref() {
        Some("png") => Ok(ImageFormat::Png),
        Some("jpg" | "jpeg") => Ok(ImageFormat::Jpeg),
        Some("webp") => Ok(ImageFormat::WebP),
        _ => Err("Only PNG, JPG, JPEG, and WebP images are supported".into()),
    }
}

fn encode_image(image: &DynamicImage, format: ImageFormat) -> Result<Vec<u8>, String> {
    let mut output = std::io::Cursor::new(Vec::new());
    match format {
        ImageFormat::Jpeg => JpegEncoder::new_with_quality(&mut output, 95)
            .encode_image(&DynamicImage::ImageRgb8(image.to_rgb8())),
        other => image.write_to(&mut output, other),
    }
    .map_err(|error| format!("Cannot encode image: {error}"))?;
    Ok(output.into_inner())
}

/// Copies EXIF data (capture date, camera, GPS) from `original` into `encoded`.
/// Edited pixels are already upright, so the orientation tag is reset.
fn copy_metadata(encoded: Vec<u8>, original: &[u8]) -> Vec<u8> {
    use img_parts::{Bytes, DynImage, ImageEXIF};
    let Some(exif) = DynImage::from_bytes(Bytes::copy_from_slice(original))
        .ok()
        .flatten()
        .and_then(|image| image.exif())
    else {
        return encoded;
    };
    let Ok(Some(mut image)) = DynImage::from_bytes(Bytes::from(encoded.clone())) else {
        return encoded;
    };
    let mut exif = exif.to_vec();
    reset_orientation(&mut exif);
    image.set_exif(Some(Bytes::from(exif)));
    let mut output = Vec::with_capacity(encoded.len() + 4096);
    match image.encoder().write_to(&mut output) {
        Ok(_) => output,
        Err(_) => encoded,
    }
}

fn reset_orientation(exif: &mut [u8]) {
    let start = if exif.starts_with(b"Exif\0\0") { 6 } else { 0 };
    let tiff = &mut exif[start..];
    let little = match tiff.get(..2) {
        Some([b'I', b'I']) => true,
        Some([b'M', b'M']) => false,
        _ => return,
    };
    let read = |bytes: &[u8], at: usize, size: usize| -> Option<usize> {
        let field = bytes.get(at..at.checked_add(size)?)?;
        Some(field.iter().enumerate().fold(0, |value, (index, byte)| {
            let shift = 8 * if little { index } else { size - 1 - index };
            value | (*byte as usize) << shift
        }))
    };
    let Some(directory) = read(tiff, 4, 4) else { return };
    let Some(count) = read(tiff, directory, 2) else { return };
    for entry in (0..count).map(|index| directory + 2 + index * 12) {
        if read(tiff, entry, 2) == Some(0x0112) {
            if let Some(value) = tiff.get_mut(entry + 8..entry + 10) {
                value.copy_from_slice(if little { &[1, 0] } else { &[0, 1] });
            }
            return;
        }
    }
}

/// Replaces `path` atomically so an interrupted save never leaves a truncated picture.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut file = Builder::new()
        .prefix(".inpaint-save-")
        .tempfile_in(parent)
        .map_err(|error| format!("Cannot write image: {error}"))?;
    file.write_all(bytes).map_err(|error| format!("Cannot write image: {error}"))?;
    let permissions = fs::metadata(path)
        .map(|metadata| metadata.permissions())
        .unwrap_or_else(|_| fs::Permissions::from_mode(0o644));
    file.as_file().set_permissions(permissions).map_err(|error| format!("Cannot write image: {error}"))?;
    file.as_file().sync_all().map_err(|error| format!("Cannot write image: {error}"))?;
    file.persist(path).map_err(|error| format!("Cannot replace image: {}", error.error))?;
    Ok(())
}

/// Saves the edited picture. Returns a note to show when the picture belongs to an Immich-compatible
/// image store, whose thumbnail Immich is then asked to rebuild.
#[tauri::command]
async fn save_image(path: String, image_data: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let format = image_format_for(&path)?;
        let bytes = decode_data_url(&image_data)?;
        let image = image::load_from_memory(&bytes).map_err(|error| format!("Cannot decode edited image: {error}"))?;
        let previous_size = image::image_dimensions(&path).ok();
        let mut encoded = encode_image(&image, format)?;
        // Keep capture dates and locations so photo libraries still place the picture correctly.
        if let Ok(original) = fs::read(&path) {
            encoded = copy_metadata(encoded, &original);
        }
        replace_file(&path, &encoded)?;
        let size_changed = previous_size != Some((image.width(), image.height()));
        let saved = fs::canonicalize(&path).unwrap_or(path);
        stores::record_picture(&saved);
        Ok(immich::refresh_saved_picture(&saved, size_changed))
    })
    .await
    .map_err(|error| format!("Save task failed: {error}"))?
}

fn image_entry(path: &Path) -> Option<ImageEntry> {
    let extension = picture_extension(path)?;
    let metadata = fs::metadata(path).ok().filter(|metadata| metadata.is_file())?;
    Some(ImageEntry {
        name: path.file_name()?.to_string_lossy().into_owned(),
        path: path_string(path),
        extension,
        size: metadata.len(),
        modified_ms: stores::modified_ms(&metadata),
    })
}

#[derive(Serialize)]
struct Deletion {
    /// False when the trash was unavailable; the message then says why.
    deleted: bool,
    message: String,
}

/// Deletes a picture: through Immich for Immich-compatible stores, otherwise into the desktop trash.
/// `permanent` removes the file for good, for when the trash is unavailable, as on some network shares.
#[tauri::command]
async fn delete_image(path: String, permanent: bool) -> Result<Deletion, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = PathBuf::from(&path);
        if picture_extension(&file).is_none() || !file.is_file() {
            return Err(format!("{path} is not a picture."));
        }
        let canonical = fs::canonicalize(&file).unwrap_or_else(|_| file.clone());
        if let Some(result) = immich::trash_picture(&canonical) {
            if result.is_ok() {
                stores::forget_picture(&canonical);
            }
            return result.map(|message| Deletion { deleted: true, message });
        }
        if permanent {
            fs::remove_file(&file).map_err(|error| format!("Cannot delete {path}: {error}"))?;
            stores::forget_picture(&canonical);
            return Ok(Deletion { deleted: true, message: "Deleted.".into() });
        }
        // GLib's trash, as file managers use it, including the trash folders of other drives.
        use gtk::gio::prelude::FileExt;
        match gtk::gio::File::for_path(&file).trash(gtk::gio::Cancellable::NONE) {
            Ok(()) => {
                stores::forget_picture(&canonical);
                Ok(Deletion { deleted: true, message: "Moved to the trash.".into() })
            }
            Err(error) => Ok(Deletion { deleted: false, message: format!("It cannot be moved to the trash: {error}") }),
        }
    })
    .await
    .map_err(|error| format!("Delete task failed: {error}"))?
}

/// Current details of pictures, such as ones just saved; None for pictures that are gone.
#[tauri::command]
fn image_entries(paths: Vec<String>) -> Vec<Option<ImageEntry>> {
    paths.iter().map(|path| image_entry(Path::new(path))).collect()
}

fn python_executable() -> PathBuf {
    #[cfg(feature = "flatpak")]
    { PathBuf::from("/app/bin/python3.11") }

    #[cfg(not(feature = "flatpak"))]
    {
    let project_venv = project_dir().join(".venv/bin/python");
    if project_venv.is_file() {
        project_venv
    } else {
        PathBuf::from("python3")
    }
    }
}

struct ModelWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    loaded_models: Vec<String>,
    loaded_plugins: Vec<String>,
    next_request_id: u64,
    healthy: bool,
}

impl ModelWorker {
    fn start() -> Result<Self, String> {
        let project_dir = project_dir();
        let models_dir = project_dir.join("models");
        let runtime_dir = models_dir.join(".runtime");
        let script_path = runtime_dir.join("inpaint_worker.py");
        fs::create_dir_all(&runtime_dir)
            .map_err(|error| format!("Cannot create model runtime directory: {error}"))?;
        fs::write(&script_path, INPAINT_SCRIPT)
            .map_err(|error| format!("Cannot prepare persistent model worker: {error}"))?;
        fs::write(runtime_dir.join("face_swap.py"), FACE_SWAP_SCRIPT)
            .map_err(|error| format!("Cannot prepare face-swap worker: {error}"))?;
        fs::write(runtime_dir.join("upscale.py"), UPSCALE_SCRIPT)
            .map_err(|error| format!("Cannot prepare upscaling worker: {error}"))?;
        fs::write(runtime_dir.join("restore.py"), RESTORE_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(runtime_dir.join("restormer.py"), RESTORMER_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(runtime_dir.join("restormer_arch.py"), RESTORMER_ARCH_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(runtime_dir.join("editing.py"), EDITING_SCRIPT)
            .map_err(|error| format!("Cannot prepare editing worker: {error}"))?;
        fs::write(runtime_dir.join("advanced.py"), ADVANCED_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(runtime_dir.join("downloads.py"), DOWNLOADS_SCRIPT).map_err(|e| e.to_string())?;
        fs::write(runtime_dir.join("worker_protocol.py"), PROTOCOL_SCRIPT).map_err(|e| e.to_string())?;

        let mut child = Command::new(python_executable())
            .arg(&script_path)
            .arg("--worker")
            .arg(&models_dir)
            .env("XDG_CACHE_HOME", &models_dir)
            .env("TORCH_HOME", models_dir.join("torch"))
            .env("HF_HOME", models_dir.join("huggingface"))
            .env("HUGGINGFACE_HUB_CACHE", models_dir.join("huggingface/hub"))
            .env("LAMA_MODEL", models_dir.join("lama/big-lama.pt"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                format!("Cannot start the model worker: {error}. Run scripts/setup-model.sh first.")
            })?;

        let stdin = child.stdin.take().ok_or_else(|| "Model worker has no input pipe".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "Model worker has no output pipe".to_string())?;
        let mut worker = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            loaded_models: Vec::new(),
            loaded_plugins: Vec::new(),
            next_request_id: 1,
            healthy: true,
        };
        let ready = worker.read_message(None)?;
        if ready.get("ready").and_then(|value| value.as_bool()) != Some(true) {
            return Err("Model worker did not become ready".into());
        }
        Ok(worker)
    }

    fn read_message(&mut self, request_id: Option<u64>) -> Result<serde_json::Value, String> {
        loop {
            let mut line = String::new();
            let bytes = self
                .stdout
                .read_line(&mut line)
                .map_err(|error| format!("Cannot read model worker response: {error}"))?;
            if bytes == 0 {
                return Err("Model worker stopped unexpectedly".into());
            }
            // Model configuration/log output is never a completed request.
            if let Some(payload) = line.strip_prefix("INPAINT_RPC:") {
                let value: serde_json::Value = serde_json::from_str(payload)
                    .map_err(|error| format!("Invalid model worker response: {error}"))?;
                if value["request_id"].as_u64() != request_id { continue; }
                if value["event"].as_str() == Some("progress") {
                    if let Some(app) = APP_HANDLE.get() { let _ = app.emit("model-progress", &value); }
                    continue;
                }
                if request_id.is_some() && value["ok"].as_bool().is_none() {
                    return Err("Model worker response has no completion status".into());
                }
                if let Some(app) = APP_HANDLE.get() { let _ = app.emit("model-progress", serde_json::json!({"done": true})); }
                return Ok(value);
            }
        }
    }

    fn request(&mut self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let mut request = request.clone();
        request["request_id"] = serde_json::json!(request_id);
        let response = (|| {
            serde_json::to_writer(&mut self.stdin, &request)
                .map_err(|error| format!("Cannot send model request: {error}"))?;
            self.stdin.write_all(b"\n").and_then(|_| self.stdin.flush())
                .map_err(|error| format!("Cannot flush model request: {error}"))?;
            self.read_message(Some(request_id))
        })();
        match response {
            Ok(value) => {
                self.update_loaded_models(&value);
                if value["ok"].as_bool() == Some(true) { Ok(value) }
                else { Err(value["error"].as_str().unwrap_or("Image operation failed").to_string()) }
            }
            Err(error) => {
                // Stop the process before callers drop their temporary folders.
                // The next operation starts a fresh worker; don't replay exports.
                self.healthy = false;
                self.shutdown();
                if let Some(app) = APP_HANDLE.get() { let _ = app.emit("model-progress", serde_json::json!({"done": true})); }
                Err(format!("{error}. Run the operation again to reconnect the model worker."))
            }
        }
    }

    fn inpaint(
        &mut self,
        input: &Path,
        mask: &Path,
        output: &Path,
        model: &str,
        prompt: &str,
    ) -> Result<(), String> {
        let request = serde_json::json!({
            "command": "inpaint",
            "input": input,
            "mask": mask,
            "output": output,
            "model": model,
            "prompt": prompt,
        });
        self.request(&request).map(|_| ())
    }

    fn run_plugin(
        &mut self,
        input: &Path,
        output: &Path,
        plugin: &str,
        option: &str,
        scale: f64,
        donor: Option<&Path>,
        denoise: f64,
        strength: f64,
    ) -> Result<(), String> {
        let request = serde_json::json!({
            "command": "plugin",
            "input": input,
            "output": output,
            "plugin": plugin,
            "option": option,
            "scale": scale,
            "donor": donor,
            "denoise": denoise,
            "strength": strength,
        });
        self.request(&request).map(|_| ())
    }

    fn update_loaded_models(&mut self, response: &serde_json::Value) {
        self.loaded_models = serde_json::from_value(response["models"].clone()).unwrap_or_default();
        self.loaded_plugins = serde_json::from_value(response["plugins"].clone()).unwrap_or_default();
    }

    fn action(&mut self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        self.request(request)
    }

    fn shutdown(&mut self) {
        let _ = self.stdin.write_all(b"{\"command\":\"shutdown\"}\n");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.loaded_models.clear(); self.loaded_plugins.clear();
    }
}

fn ensure_worker(worker: &mut Option<ModelWorker>) -> Result<&mut ModelWorker, String> {
    let restart = worker.as_mut().is_some_and(|active| {
        !active.healthy || !matches!(active.child.try_wait(), Ok(None))
    });
    if restart { worker.take(); }
    if worker.is_none() { *worker = Some(ModelWorker::start()?); }
    Ok(worker.as_mut().expect("worker was initialized"))
}

impl Drop for ModelWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone, Default)]
struct InpaintWorkerState {
    worker: Arc<Mutex<Option<ModelWorker>>>,
}

impl InpaintWorkerState {
    fn shutdown(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(mut active) = worker.take() {
                active.shutdown();
            }
        }
    }
}

#[tauri::command]
fn loaded_models(state: tauri::State<'_, InpaintWorkerState>) -> Vec<String> {
    state
        .worker
        .lock()
        .ok()
        .and_then(|worker| worker.as_ref().map(|active| active.loaded_models.clone()))
        .unwrap_or_default()
}

#[tauri::command]
fn loaded_plugins(state: tauri::State<'_, InpaintWorkerState>) -> Vec<String> {
    state
        .worker
        .lock()
        .ok()
        .and_then(|worker| worker.as_ref().map(|active| active.loaded_plugins.clone()))
        .unwrap_or_default()
}

#[tauri::command]
async fn run_inpaint(
    state: tauri::State<'_, InpaintWorkerState>,
    image_data: String,
    mask_data: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    let worker_state = state.worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(model.as_str(), "lama" | "mat" | "zits" | "migan" | "sdxl") {
            return Err(format!("Unsupported inpainting model: {model}"));
        }
        let work_dir = Builder::new()
            .prefix("inpaint-")
            .tempdir()
            .map_err(|error| format!("Cannot create temporary directory: {error}"))?;
        let input_path = work_dir.path().join("input.png");
        let mask_path = work_dir.path().join("mask.png");
        let output_path = work_dir.path().join("output.png");

        fs::write(&input_path, decode_data_url(&image_data)?)
            .map_err(|error| format!("Cannot prepare source image: {error}"))?;
        fs::write(&mask_path, decode_data_url(&mask_data)?)
            .map_err(|error| format!("Cannot prepare mask: {error}"))?;
        let mut worker = worker_state
            .lock()
            .map_err(|_| "Model worker lock is poisoned".to_string())?;
        ensure_worker(&mut worker)?
            .inpaint(&input_path, &mask_path, &output_path, &model, &prompt)?;

        let output = fs::read(output_path).map_err(|error| format!("Cannot read model result: {error}"))?;
        Ok(format!("data:image/png;base64,{}", BASE64.encode(output)))
    })
    .await
    .map_err(|error| format!("Model task failed: {error}"))?
}

#[tauri::command]
async fn run_plugin(
    state: tauri::State<'_, InpaintWorkerState>,
    image_data: String,
    plugin: String,
    option: String,
    scale: f64,
    source_image_data: Option<String>,
    denoise: Option<f64>,
    strength: Option<f64>,
) -> Result<String, String> {
    let worker_state = state.worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(plugin.as_str(), "gfpgan" | "realesrgan" | "remove_bg" | "face_swap" | "hat" | "lanczos" | "restore") {
            return Err(format!("Unsupported image plugin: {plugin}"));
        }
        if !scale.is_finite() || !(1.0..=4.0).contains(&scale) {
            return Err("Plugin scale must be between 1 and 4".to_string());
        }
        let denoise = denoise.unwrap_or(0.25);
        if !denoise.is_finite() || !(0.0..=1.0).contains(&denoise) {
            return Err("Denoising strength must be between 0 and 1".into());
        }
        let strength = strength.unwrap_or(1.0);
        if !strength.is_finite() || !(0.0..=1.0).contains(&strength) {
            return Err("Restoration strength must be between 0 and 1".into());
        }
        if plugin == "restore" && (scale != 1.0 || !matches!(option.as_str(), "compressed" | "natural" | "jpeg" | "noise" | "motion")) {
            return Err("Choose a supported Restore detail mode at the original resolution".into());
        }
        let work_dir = Builder::new()
            .prefix("inpaint-plugin-")
            .tempdir()
            .map_err(|error| format!("Cannot create plugin temporary directory: {error}"))?;
        let input_path = work_dir.path().join("input.png");
        let output_path = work_dir.path().join("output.png");
        fs::write(&input_path, decode_data_url(&image_data)?)
            .map_err(|error| format!("Cannot prepare plugin source image: {error}"))?;
        let donor_path = if plugin == "face_swap" {
            let source = source_image_data.as_deref()
                .ok_or_else(|| "Select a source photo before replacing a face".to_string())?;
            let path = work_dir.path().join("donor.png");
            fs::write(&path, decode_data_url(source)?)
                .map_err(|error| format!("Cannot prepare face source photo: {error}"))?;
            Some(path)
        } else {
            None
        };

        let mut worker = worker_state
            .lock()
            .map_err(|_| "Model worker lock is poisoned".to_string())?;
        ensure_worker(&mut worker)?
            .run_plugin(&input_path, &output_path, &plugin, &option, scale, donor_path.as_deref(), denoise, strength)?;

        let output = fs::read(output_path)
            .map_err(|error| format!("Cannot read plugin result: {error}"))?;
        Ok(format!("data:image/png;base64,{}", BASE64.encode(output)))
    })
    .await
    .map_err(|error| format!("Plugin task failed: {error}"))?
}

#[tauri::command]
async fn image_action(
    state: tauri::State<'_, InpaintWorkerState>,
    command: String,
    image_data: Option<String>,
    reference_data: Option<String>,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let worker_state = state.worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(command.as_str(), "memory" | "unload" | "detect_faces" | "face_preview" | "edit" | "export" | "select" | "mask_edit" | "retouch" | "refine_edges" | "outpaint") {
            return Err("Unsupported image action".into());
        }
        let work_dir = Builder::new().prefix("inpaint-edit-").tempdir().map_err(|e| e.to_string())?;
        let input = work_dir.path().join("input.png");
        let output = work_dir.path().join("output.png");
        let raw_output = work_dir.path().join("raw.png");
        let reference = work_dir.path().join("reference.png");
        if let Some(data) = image_data {
            fs::write(&input, decode_data_url(&data)?).map_err(|e| e.to_string())?;
        } else if !matches!(command.as_str(), "memory" | "unload") {
            return Err("No image was provided".into());
        }
        if let Some(data) = reference_data {
            fs::write(&reference, decode_data_url(&data)?).map_err(|e| e.to_string())?;
        }
        let request = serde_json::json!({"command": command, "input": input, "output": output,
            "raw_output": raw_output, "reference": if reference.is_file() { Some(&reference) } else { None }, "options": options});
        let mut worker = worker_state.lock().map_err(|_| "Worker lock failed".to_string())?;
        let mut response = ensure_worker(&mut worker)?.action(&request)?;
        for (path, key) in [(&output, "imageData"), (&raw_output, "rawData")] {
            if path.is_file() {
                let bytes = fs::read(path).map_err(|e| e.to_string())?;
                response[key] = serde_json::json!(format!("data:image/png;base64,{}", BASE64.encode(bytes)));
            }
        }
        Ok(response)
    }).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// WebKitGTK renders the UI on the GPU and hands finished frames to the window as DMA-BUF GPU buffers.
/// With NVIDIA's proprietary driver those buffers show a blank white window, so there frames travel through
/// shared memory instead, which keeps GPU rendering and compositing. Measured scrolling the gallery at 4K
/// on NVIDIA: 42 fps this way, 12 fps with the DMA-BUF renderer disabled (the earlier workaround), and a
/// white window with DMA-BUF buffers. `INPAINT_RENDERER=gpu|shared-memory|software` chooses explicitly;
/// WebKit switches set by the user are left alone. PyTorch/CUDA inference is not affected.
#[cfg(target_os = "linux")]
fn configure_webkit_renderer() {
    const SWITCHES: [&str; 3] = ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DMABUF_RENDERER_FORCE_SHM", "WEBKIT_DISABLE_COMPOSITING_MODE"];
    if SWITCHES.iter().any(|name| std::env::var_os(name).is_some()) {
        return;
    }
    let nvidia = Path::new("/proc/driver/nvidia/version").exists();
    let choice = std::env::var("INPAINT_RENDERER").unwrap_or_else(|_| if nvidia { "shared-memory" } else { "gpu" }.to_string());
    match choice.as_str() {
        "gpu" => {}
        "software" => std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        _ => std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
    }
}

pub fn run() {
    let context = tauri::generate_context!();
    if std::env::args().nth(1).as_deref() == Some("--check-assets") {
        let assets = context.assets();
        let index = assets.get(&"index.html".into()).unwrap_or_else(|| {
            eprintln!("Embedded index.html is missing");
            for (key, _) in assets.iter() {
                eprintln!("Embedded asset: {key}");
            }
            std::process::exit(1);
        });
        let html = String::from_utf8_lossy(&index);
        for attribute in ["src=\"/", "href=\"/"] {
            for reference in html.split(attribute).skip(1) {
                let path = reference.split('"').next().unwrap_or_default();
                if assets.get(&path.into()).is_none() {
                    eprintln!("Embedded asset referenced by index.html is missing: {path}");
                    std::process::exit(1);
                }
            }
        }
        println!("Embedded index.html and its scripts/styles are available");
        return;
    }

    #[cfg(target_os = "linux")]
    configure_webkit_renderer();

    let worker_state = InpaintWorkerState::default();
    let shutdown_state = worker_state.clone();
    let app = tauri::Builder::default()
        // Starting Inpaint again brings back the running window, even from the tray, instead of
        // a second copy whose API server could not get the port. Must be the first plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_window(app)))
        .manage(worker_state)
        .manage(runtime::SetupState::default())
        .manage(server::ServerState::default())
        .manage(tray::TrayState::default())
        .manage(stores::StoresState::default())
        .manage(dropbox::DropboxState::default())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", |_context, request, responder| {
            tauri::async_runtime::spawn_blocking(move || responder.respond(thumbnail_response(&request)));
        })
        .setup(|app| {
            dropbox::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // With a tray icon, closing or minimizing hides the window and the app keeps running.
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" && tray::keeps_running(window.app_handle()) => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // The drop box window would keep the app running, so closing the main window exits.
                tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => window.app_handle().exit(0),
                // Linux reports minimizing as a resize. Clearing the minimized state after hiding
                // lets the tray show a normal window again instead of a minimized one.
                tauri::WindowEvent::Resized(_)
                    if window.label() == "main" && window.is_minimized().unwrap_or(false) && tray::keeps_running(window.app_handle()) =>
                {
                    let _ = window.hide();
                    let _ = window.unminimize();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_directory,
            list_folders,
            read_image_data,
            read_thumbnail_data,
            save_image,
            image_entries,
            delete_image,
            loaded_models,
            loaded_plugins,
            run_inpaint,
            run_plugin,
            image_action,
            runtime::runtime_status,
            runtime::setup_runtime,
            runtime::hf_token_status,
            runtime::save_hf_token,
            runtime::open_model_access,
            server::server_status,
            server::server_configure,
            server::server_new_token,
            server::server_bridge,
            server::server_take_job,
            server::server_job_result,
            db::preferences_all,
            db::preferences_set,
            db::preferences_import,
            stores::stores_list,
            stores::store_create,
            stores::store_update,
            stores::store_remove,
            stores::store_cached,
            stores::store_scan,
            immich::immich_settings,
            immich::immich_configure,
            immich::immich_test,
            immich::immich_asset,
            immich::immich_catalog,
            immich::immich_update,
            immich::immich_tag,
            immich::immich_create_tag,
            immich::immich_album,
            immich::immich_create_album,
            immich::immich_open,
            dropbox::dropbox_status,
            dropbox::dropbox_configure,
            dropbox::dropbox_set,
            dropbox::dropbox_overlay_state,
            dropbox::dropbox_save_clipboard,
            dropbox::dropbox_open_settings,
        ])
        .build(context)
        .expect("error while building Inpaint");
    let _ = APP_HANDLE.set(app.handle().clone());
    std::thread::spawn(prune_thumbnail_cache);
    server::start_saved(app.handle());
    tray::start(app.handle());

    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            shutdown_state.shutdown();
        }
    });
}
