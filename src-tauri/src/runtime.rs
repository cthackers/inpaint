use std::{fs, io::{BufRead, BufReader, Read, Write}, path::PathBuf, process::{Command, Stdio}, sync::{Arc, Mutex}};
use serde::Serialize;
use tauri::State;

const UV: &[u8] = include_bytes!("../../resources/uv.gz");
const FACE_WHEEL: &[u8] = include_bytes!("../../resources/insightface-0.7.3-cp311-cp311-linux_x86_64.whl");

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub running: bool, pub ready: bool, pub stage: String, pub log: Vec<String>, pub directory: String, pub error: Option<String> }
#[derive(Clone, Default)]
pub struct SetupState(pub Arc<Mutex<Status>>);

fn is_ready(root: &PathBuf) -> bool {
    root.join(".venv/bin/python").is_file() && (!root.join(".runtime-managed").exists() || root.join(".runtime-ready").exists())
}

#[tauri::command]
pub fn runtime_status(state: State<'_, SetupState>) -> Result<Status, String> {
    let root = super::project_dir();
    let mut status = state.0.lock().map_err(|e| e.to_string())?.clone();
    status.directory = root.to_string_lossy().into();
    status.ready = is_ready(&root) && !status.running;
    Ok(status)
}

fn run(uv: &PathBuf, root: &PathBuf, args: &[&str], stage: &str, state: &Arc<Mutex<Status>>) -> Result<(), String> {
    { let mut status = state.lock().unwrap(); status.stage = stage.into(); status.log.push(stage.into()); }
    let mut child = Command::new(uv).args(args)
        .env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_CACHE_DIR", root.join(".cache/uv"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_HTTP_RETRIES", "3").env("UV_HTTP_TIMEOUT", "120")
        .env("UV_NO_PROGRESS", "1").env("UV_NO_CONFIG", "1")
        .stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().unwrap();
    for line in BufReader::new(stderr).lines() {
        if let Ok(line) = line {
            let mut status = state.lock().unwrap();
            status.log.push(line);
            if status.log.len() > 120 { status.log.remove(0); }
        }
    }
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err(format!("{stage} failed. Check the installation log and click Retry."));
    }
    Ok(())
}

#[tauri::command]
pub async fn setup_runtime(state: State<'_, SetupState>, gpu: bool) -> Result<(), String> {
    let shared = state.0.clone();
    {
        let mut status = shared.lock().map_err(|e| e.to_string())?;
        if status.running { return Err("Setup is already running.".into()); }
        status.running = true; status.error = None; status.log.clear();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result: Result<(), String> = (|| {
            let root = super::project_dir();
            fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            fs::write(root.join(".runtime-managed"), b"1").map_err(|e| e.to_string())?;
            let bin = root.join("runtime-tools");
            fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
            let uv = bin.join("uv");
            let mut decoded = Vec::new();
            flate2::read::GzDecoder::new(UV).read_to_end(&mut decoded).map_err(|e| e.to_string())?;
            let staged = bin.join("uv.installing");
            fs::write(&staged, decoded).map_err(|e| e.to_string())?;
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            fs::rename(staged, &uv).map_err(|e| e.to_string())?;
            let wheel = bin.join("insightface-0.7.3-cp311-cp311-linux_x86_64.whl");
            fs::write(&wheel, FACE_WHEEL).map_err(|e| e.to_string())?;
            fs::write(bin.join("uv-LICENSE-MIT"), include_bytes!("../../resources/uv-LICENSE-MIT")).map_err(|e| e.to_string())?;
            fs::write(bin.join("InsightFace-LICENSE"), include_bytes!("../../resources/InsightFace-LICENSE")).map_err(|e| e.to_string())?;
            run(&uv, &root, &["python", "install", "3.11"], "1/4 · Downloading Python 3.11", &shared)?;
            let venv = root.join(".venv").to_string_lossy().into_owned();
            if !root.join(".venv/bin/python").exists() {
                run(&uv, &root, &["venv", "--allow-existing", "--python", "3.11", &venv], "Creating the application environment", &shared)?;
            }
            let python = root.join(".venv/bin/python").to_string_lossy().into_owned();
            let index = if gpu { "https://download.pytorch.org/whl/cu128" } else { "https://download.pytorch.org/whl/cpu" };
            run(&uv, &root, &["pip", "install", "--python", &python, "--index-url", index, "torch==2.11.0", "torchvision==0.26.0"], "2/4 · Installing image processing runtime", &shared)?;
            run(&uv, &root, &["pip", "install", "--python", &python,
                "iopaint==1.6.0", "simple-lama-inpainting==0.1.2", "numpy==1.26.4", "Pillow==9.5.0",
                "huggingface-hub==0.25.2", "transformers==4.48.3", "diffusers==0.27.2", "timm==1.0.28",
                "onnxruntime==1.19.2", "scikit-image==0.24.0", "rembg==2.0.57", "spandrel==0.4.2",
                "gdown==5.2.0", "onnx==1.17.0", "albumentations==1.3.1", "opencv-python-headless==4.11.0.86",
                "psutil", &wheel.to_string_lossy()], "3/4 · Installing editing tools", &shared)?;
            if gpu {
                run(&uv, &root, &["pip", "uninstall", "--python", &python, "onnxruntime"], "Preparing GPU face runtime", &shared)?;
                run(&uv, &root, &["pip", "install", "--python", &python, "--no-deps", "onnxruntime-gpu==1.23.2"], "4/4 · Installing GPU face runtime", &shared)?;
            }
            fs::write(root.join(".runtime-ready"), b"1").map_err(|e| e.to_string())?;
            let mut status = shared.lock().unwrap(); status.ready = true; status.stage = "Ready. Models download when first used.".into();
            Ok(())
        })();
        let mut status = shared.lock().unwrap(); status.running = false;
        if let Err(ref error) = result { status.error = Some(error.clone()); }
        result
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn hf_token_status() -> bool {
    super::project_dir().join("models/huggingface/token").is_file() || std::env::var_os("HF_TOKEN").is_some()
}

#[tauri::command]
pub fn save_hf_token(token: String) -> Result<(), String> {
    let path = super::project_dir().join("models/huggingface/token");
    let token = token.trim();
    if token.is_empty() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Cannot remove saved token".into()),
        };
    }
    if !token.starts_with("hf_") || token.chars().any(char::is_whitespace) { return Err("Enter a Hugging Face access token beginning with hf_.".into()); }
    fs::create_dir_all(path.parent().unwrap()).map_err(|_| "Cannot create token directory".to_string())?;
    use std::os::unix::fs::PermissionsExt;
    // Replace atomically so an active downloader never reads a truncated token.
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|_| "Cannot prepare token file".to_string())?;
    file.as_file().set_permissions(fs::Permissions::from_mode(0o600)).map_err(|_| "Cannot secure token file".to_string())?;
    file.write_all(token.as_bytes()).map_err(|_| "Cannot save token".to_string())?;
    file.as_file().sync_all().map_err(|_| "Cannot save token".to_string())?;
    file.persist(path).map_err(|_| "Cannot replace saved token".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_model_access(tokens: bool) -> Result<(), String> {
    let url = if tokens { "https://huggingface.co/settings/tokens" } else { "https://huggingface.co/briaai/RMBG-2.0" };
    Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
