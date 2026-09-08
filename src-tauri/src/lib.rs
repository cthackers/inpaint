use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tempfile::Builder;
use tauri::Emitter;
mod runtime;
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

const INPAINT_SCRIPT: &str = include_str!("../../backend/inpaint.py");
const FACE_SWAP_SCRIPT: &str = include_str!("../../backend/face_swap.py");
const RESTORMER_SCRIPT: &str = include_str!("../../backend/restormer.py");
const RESTORMER_ARCH_SCRIPT: &str = include_str!("../../backend/restormer_arch.py");
const UPSCALE_SCRIPT: &str = include_str!("../../backend/upscale.py");
const EDITING_SCRIPT: &str = include_str!("../../backend/editing.py");
const ADVANCED_SCRIPT: &str = include_str!("../../backend/advanced.py");
const DOWNLOADS_SCRIPT: &str = include_str!("../../backend/downloads.py");
const PROTOCOL_SCRIPT: &str = include_str!("../../backend/worker_protocol.py");

#[derive(Serialize)]
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
            let Some(extension) = image_extension(&entry_path) else { continue };
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
fn read_image_data(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let mime = mime_for(&path)?;
    let data = fs::read(&path).map_err(|error| format!("Cannot read image: {error}"))?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(data)))
}

#[tauri::command]
async fn read_thumbnail_data(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        mime_for(&path)?;

        // ImageMagick is heavily optimized even while this app is running as a
        // development build. Prefer it for previews; retain the image-crate
        // path so packaged builds still work when ImageMagick is unavailable.
        if let Ok(result) = Command::new("magick")
            .args(["-define", "jpeg:size=960x720"])
            .arg(&path)
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
                return Ok(format!(
                    "data:image/jpeg;base64,{}",
                    BASE64.encode(result.stdout)
                ));
            }
        }

        let image = image::open(&path)
            .map_err(|error| format!("Cannot decode thumbnail: {error}"))?;
        let thumbnail = image.thumbnail(480, 360).to_rgb8();
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, 82)
            .encode_image(&thumbnail)
            .map_err(|error| format!("Cannot encode thumbnail: {error}"))?;
        Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(output)))
    })
    .await
    .map_err(|error| format!("Thumbnail task failed: {error}"))?
}

fn write_image(path: &Path, image: DynamicImage) -> Result<(), String> {
    let extension = image_extension(path).ok_or_else(|| "Unsupported destination format".to_string())?;
    let file = fs::File::create(path).map_err(|error| format!("Cannot overwrite image: {error}"))?;
    let mut writer = BufWriter::new(file);
    match extension.as_str() {
        "jpg" | "jpeg" => JpegEncoder::new_with_quality(&mut writer, 95)
            .encode_image(&DynamicImage::ImageRgb8(image.to_rgb8()))
            .map_err(|error| format!("Cannot encode JPEG: {error}"))?,
        "png" => image
            .write_to(&mut writer, ImageFormat::Png)
            .map_err(|error| format!("Cannot encode PNG: {error}"))?,
        "webp" => image
            .write_to(&mut writer, ImageFormat::WebP)
            .map_err(|error| format!("Cannot encode WebP: {error}"))?,
        _ => return Err("Unsupported destination format".into()),
    }
    writer.flush().map_err(|error| format!("Cannot finish writing image: {error}"))
}

#[tauri::command]
fn save_image(path: String, image_data: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    mime_for(&path)?;
    let bytes = decode_data_url(&image_data)?;
    let image = image::load_from_memory(&bytes).map_err(|error| format!("Cannot decode edited image: {error}"))?;
    write_image(&path, image)
}

fn python_executable() -> PathBuf {
    let project_venv = project_dir().join(".venv/bin/python");
    if project_venv.is_file() {
        project_venv
    } else {
        PathBuf::from("python3")
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
        if !matches!(plugin.as_str(), "gfpgan" | "realesrgan" | "remove_bg" | "face_swap" | "hat" | "lanczos" | "restormer") {
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
        if plugin == "restormer" && (scale != 1.0 || !matches!(option.as_str(), "motion" | "defocus" | "denoise")) {
            return Err("Choose a supported Restormer model at its original resolution".into());
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

    // WebKitGTK's DMA-BUF renderer can produce a blank window with NVIDIA's
    // proprietary driver. This only affects the UI webview; PyTorch/CUDA
    // inference continues to use the GPU normally.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let worker_state = InpaintWorkerState::default();
    let shutdown_state = worker_state.clone();
    let app = tauri::Builder::default()
        .manage(worker_state)
        .manage(runtime::SetupState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_directory,
            list_folders,
            read_image_data,
            read_thumbnail_data,
            save_image,
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
        ])
        .build(context)
        .expect("error while building Inpaint");
    let _ = APP_HANDLE.set(app.handle().clone());

    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            shutdown_state.shutdown();
        }
    });
}
