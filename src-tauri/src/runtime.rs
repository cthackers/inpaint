use std::{fs, io::Write, path::PathBuf, process::Command, sync::{Arc, Mutex}};
#[cfg(not(feature = "flatpak"))]
use std::{io::{BufRead, BufReader, Read}, process::Stdio};
use serde::Serialize;
use tauri::State;

#[cfg(not(feature = "flatpak"))]
const UV: &[u8] = include_bytes!("../../resources/uv.gz");
#[cfg(not(feature = "flatpak"))]
const FACE_WHEEL: &[u8] = include_bytes!("../../resources/insightface-0.7.3-cp311-cp311-linux_x86_64.whl");
/// The pinned packages, shared with scripts/setup-model.sh.
#[cfg(not(feature = "flatpak"))]
const REQUIREMENTS: &str = include_str!("../../resources/requirements.txt");

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub running: bool, pub ready: bool, pub stage: String, pub log: Vec<String>, pub directory: String, pub error: Option<String> }
#[derive(Clone, Default)]
pub struct SetupState(pub Arc<Mutex<Status>>);

/// The Python every pinned package and the bundled InsightFace wheel are built for.
pub const PYTHON_VERSION: &str = "3.11";

/// The Python version a virtual environment was made with, from its `pyvenv.cfg` (`version` from
/// Python's venv, `version_info` from uv).
fn venv_version(venv: &std::path::Path) -> Option<String> {
    let config = fs::read_to_string(venv.join("pyvenv.cfg")).ok()?;
    config.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        matches!(key.trim(), "version" | "version_info").then(|| value.trim().to_string())
    })
}

/// Whether the environment runs the Python the packages are pinned for. One made earlier with another
/// Python, such as the system's 3.12 or 3.13, installs nothing that works.
fn venv_matches(venv: &std::path::Path) -> bool {
    venv_version(venv).is_some_and(|version| version == PYTHON_VERSION || version.starts_with(&format!("{PYTHON_VERSION}.")))
}

/// Python and uv settings of the user's shell that would point the installer or the worker at another
/// Python or other packages than the application's own environment.
pub fn clear_python_environment(command: &mut Command) -> &mut Command {
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key.starts_with("PYTHON") || key.starts_with("UV_") || key.starts_with("PIP_") || key.starts_with("CONDA") || key == "VIRTUAL_ENV" || key == "PYENV_VERSION" {
            command.env_remove(key.as_ref());
        }
    }
    // A venv already leaves out ~/.local's packages; this keeps them out however Python is started.
    command.env("PYTHONNOUSERSITE", "1")
}

fn is_ready(root: &PathBuf) -> bool {
    #[cfg(feature = "flatpak")]
    {
        let _ = root;
        super::python_executable().is_file()
            && std::path::Path::new("/app/share/inpaint/runtime-ready").is_file()
    }
    #[cfg(not(feature = "flatpak"))]
    {
    root.join(".venv/bin/python").is_file()
        && venv_matches(&root.join(".venv"))
        && (!root.join(".runtime-managed").exists() || root.join(".runtime-ready").exists())
    }
}

#[tauri::command]
pub fn runtime_status(state: State<'_, SetupState>) -> Result<Status, String> {
    let root = super::project_dir();
    let mut status = state.0.lock().map_err(|e| e.to_string())?.clone();
    status.directory = root.to_string_lossy().into();
    status.ready = is_ready(&root) && !status.running;
    Ok(status)
}

#[cfg(not(feature = "flatpak"))]
fn run(uv: &PathBuf, root: &PathBuf, args: &[&str], stage: &str, state: &Arc<Mutex<Status>>) -> Result<(), String> {
    { let mut status = state.lock().unwrap(); status.stage = stage.into(); status.log.push(stage.into()); }
    let mut command = Command::new(uv);
    clear_python_environment(&mut command);
    let mut child = command.args(args)
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

#[cfg(feature = "flatpak")]
#[tauri::command]
pub async fn setup_runtime(state: State<'_, SetupState>, gpu: bool) -> Result<(), String> {
    let _ = (state, gpu);
    Err("The Flatpak includes its processing runtime. Update or reinstall the Flatpak to repair it.".into())
}

#[cfg(not(feature = "flatpak"))]
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
            let requirements = bin.join("requirements.txt");
            fs::write(&requirements, REQUIREMENTS).map_err(|e| e.to_string())?;
            fs::write(bin.join("uv-LICENSE-MIT"), include_bytes!("../../resources/uv-LICENSE-MIT")).map_err(|e| e.to_string())?;
            fs::write(bin.join("InsightFace-LICENSE"), include_bytes!("../../resources/InsightFace-LICENSE")).map_err(|e| e.to_string())?;
            run(&uv, &root, &["python", "install", PYTHON_VERSION], "1/4 · Downloading Python 3.11", &shared)?;
            let venv_dir = root.join(".venv");
            let venv = venv_dir.to_string_lossy().into_owned();
            // An environment made with another Python, or one whose Python is gone, is made again:
            // installing into it fails on every package built for 3.11.
            let usable = venv_matches(&venv_dir) && Command::new(venv_dir.join("bin/python")).arg("-c").arg("pass").env("PYTHONNOUSERSITE", "1").output().is_ok_and(|output| output.status.success());
            if venv_dir.exists() && !usable {
                let found = venv_version(&venv_dir).map_or_else(|| "an unknown Python".into(), |version| format!("Python {version}"));
                { let mut status = shared.lock().unwrap(); status.log.push(format!("Replacing the environment made with {found}; it needs Python {PYTHON_VERSION}.")); }
                let _ = fs::remove_file(root.join(".runtime-ready"));
                fs::remove_dir_all(&venv_dir).map_err(|e| format!("Cannot replace {venv}: {e}"))?;
            }
            if !venv_dir.join("bin/python").exists() {
                run(&uv, &root, &["venv", "--python", PYTHON_VERSION, &venv], "Creating the application environment", &shared)?;
            }
            let python = venv_dir.join("bin/python").to_string_lossy().into_owned();
            let index = if gpu { "https://download.pytorch.org/whl/cu128" } else { "https://download.pytorch.org/whl/cpu" };
            run(&uv, &root, &["pip", "install", "--python", &python, "--index-url", index, "torch==2.11.0", "torchvision==0.26.0"], "2/4 · Installing image processing runtime", &shared)?;
            run(&uv, &root, &["pip", "install", "--python", &python, "-r", &requirements.to_string_lossy(), &wheel.to_string_lossy()], "3/4 · Installing editing tools", &shared)?;
            // IOPaint asks for OpenCV's GUI build, which needs libGL and writes the same cv2 module as the
            // headless build; one cv2, from the headless build, loads without a display stack.
            let headless = REQUIREMENTS.lines().find(|line| line.starts_with("opencv-python-headless==")).ok_or("The requirements name no headless OpenCV.")?;
            run(&uv, &root, &["pip", "uninstall", "--python", &python, "opencv-python"], "Preparing OpenCV", &shared)?;
            run(&uv, &root, &["pip", "install", "--python", &python, "--reinstall", "--no-deps", headless], "Installing OpenCV", &shared)?;
            if gpu {
                run(&uv, &root, &["pip", "uninstall", "--python", &python, "onnxruntime"], "Preparing GPU face runtime", &shared)?;
                run(&uv, &root, &["pip", "install", "--python", &python, "--no-deps", "onnxruntime-gpu==1.23.2"], "4/4 · Installing GPU face runtime", &shared)?;
            }
            // Every package must import in the environment's Python before it counts as ready, so a
            // mismatch shows here with its message instead of when a tool is first used.
            {
                { let mut status = shared.lock().unwrap(); status.stage = "Checking the installation".into(); status.log.push("Checking the installation".into()); }
                let mut check = Command::new(&python);
                clear_python_environment(&mut check);
                let output = check
                    .args(["-c", "import sys; assert sys.version_info[:2] == (3, 11), sys.version; import numpy, torch, torchvision, cv2, PIL, onnxruntime, insightface, rembg, spandrel, iopaint, simple_lama_inpainting; print('Python', sys.version.split()[0], '· torch', torch.__version__, '· numpy', numpy.__version__)"])
                    .output()
                    .map_err(|e| e.to_string())?;
                let mut status = shared.lock().unwrap();
                status.log.extend(String::from_utf8_lossy(&output.stdout).lines().chain(String::from_utf8_lossy(&output.stderr).lines()).map(str::to_string));
                if !output.status.success() {
                    return Err("The installed packages do not load. Check the installation log and click Retry.".into());
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_environment_of_the_pinned_python_counts() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join(".venv");
        fs::create_dir_all(&venv).unwrap();
        assert!(!venv_matches(&venv), "no pyvenv.cfg");
        fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.13.7\n").unwrap();
        assert!(!venv_matches(&venv));
        fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\nversion = 3.110.1\n").unwrap();
        assert!(!venv_matches(&venv));
        fs::write(venv.join("pyvenv.cfg"), "home = /x\nimplementation = CPython\nuv = 0.5.0\nversion_info = 3.11.13\n").unwrap();
        assert!(venv_matches(&venv));
    }

    #[test]
    fn the_shells_python_settings_do_not_reach_the_worker() {
        std::env::set_var("PYTHONPATH", "/somewhere/else");
        std::env::set_var("UV_PYTHON", "3.13");
        let mut command = Command::new("true");
        clear_python_environment(&mut command);
        let envs: Vec<_> = command.get_envs().map(|(key, value)| (key.to_string_lossy().into_owned(), value.map(|v| v.to_string_lossy().into_owned()))).collect();
        assert!(envs.contains(&("PYTHONPATH".into(), None)));
        assert!(envs.contains(&("UV_PYTHON".into(), None)));
        assert!(envs.contains(&("PYTHONNOUSERSITE".into(), Some("1".into()))));
    }
}
