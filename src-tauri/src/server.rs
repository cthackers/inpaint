//! Local HTTP API for other programs, such as a browser extension.
//!
//! Requests are authenticated and their images resolved here. Each job is then
//! handed to the window, which runs the same operations and workflows as the
//! editor and returns the result through `server_job_result`.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as UrlPath, Query, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, ErrorKind},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const MAX_IMAGE_BYTES: usize = 256 * 1024 * 1024;
const JOB_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const SOURCE_HELP: &str = "Send images as a disk path, an http(s) URL, a data URL, or {\"data\": \"<base64>\"}.";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerSettings {
    pub enabled: bool,
    pub listen_all: bool,
    pub port: u16,
    pub token: String,
    pub allowed_folders: Vec<String>,
    pub allow_urls: bool,
    /// Where /save puts pictures sent without a path. Empty means ~/Pictures/Inpaint.
    pub save_folder: String,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            listen_all: false,
            port: 7865,
            token: new_token(),
            allowed_folders: Vec::new(),
            allow_urls: true,
            save_folder: String::new(),
        }
    }
}

impl ServerSettings {
    fn save_folder(&self) -> PathBuf {
        if !self.save_folder.is_empty() {
            return PathBuf::from(&self.save_folder);
        }
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Pictures/Inpaint")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    settings: ServerSettings,
    running: bool,
    address: Option<String>,
    error: Option<String>,
    save_folder: PathBuf,
}

#[derive(Deserialize)]
pub struct JobReply {
    ok: bool,
    image: Option<String>,
    data: Option<Value>,
    error: Option<String>,
    status: Option<u16>,
}

struct Job {
    input: Option<Value>,
    reply: oneshot::Sender<JobReply>,
}

#[derive(Default)]
struct Listener {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    address: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct Shared {
    settings: Mutex<ServerSettings>,
    listener: Mutex<Listener>,
    configuring: tokio::sync::Mutex<()>,
    jobs: Mutex<HashMap<u64, Job>>,
    next_job: AtomicU64,
    /// Mounted frontend listeners; counted so remounts cannot race each other.
    bridges: AtomicI64,
}

impl Shared {
    fn settings(&self) -> ServerSettings {
        self.settings.lock().unwrap().clone()
    }

    fn status(&self) -> ServerStatus {
        let settings = self.settings();
        let listener = self.listener.lock().unwrap();
        ServerStatus {
            save_folder: settings.save_folder(),
            settings,
            running: listener.task.is_some(),
            address: listener.address.clone(),
            error: listener.error.clone(),
        }
    }
}

#[derive(Clone, Default)]
pub struct ServerState(Arc<Shared>);

fn new_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("the system random number generator is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn load_settings() -> ServerSettings {
    match super::db::setting::<ServerSettings>("server") {
        Some(Ok(settings)) => settings,
        Some(Err(error)) => {
            eprintln!("Ignoring {error}");
            ServerSettings::default()
        }
        None => {
            // Persist the generated token so it survives a restart before the first Apply.
            let settings = ServerSettings::default();
            let _ = save_settings(&settings);
            settings
        }
    }
}

// Saved in inpaint.db, which only the user can read, so the token stays private.
fn save_settings(settings: &ServerSettings) -> Result<(), String> {
    super::db::set_setting("server", settings)
}

fn normalize_settings(mut settings: ServerSettings) -> Result<ServerSettings, String> {
    if settings.port < 1024 {
        return Err("Choose a port from 1024 to 65535.".into());
    }
    settings.token = settings.token.trim().to_string();
    if settings.token.len() < 16 || settings.token.chars().any(char::is_whitespace) {
        return Err("The access token must be at least 16 characters, without spaces.".into());
    }
    let mut folders: Vec<String> = Vec::new();
    for folder in &settings.allowed_folders {
        let path = fs::canonicalize(folder).map_err(|error| format!("Cannot use folder {folder}: {error}"))?;
        if !path.is_dir() {
            return Err(format!("{folder} is not a folder."));
        }
        let path = path.to_string_lossy().into_owned();
        if !folders.contains(&path) {
            folders.push(path);
        }
    }
    settings.allowed_folders = folders;
    settings.save_folder = settings.save_folder.trim().to_string();
    if !settings.save_folder.is_empty() && !Path::new(&settings.save_folder).is_absolute() {
        return Err("The save folder must be an absolute path.".into());
    }
    Ok(settings)
}

pub fn start_saved(app: &AppHandle) {
    let shared = app.state::<ServerState>().0.clone();
    let settings = load_settings();
    *shared.settings.lock().unwrap() = settings.clone();
    if settings.enabled {
        install(app, &shared, &settings, bind(&settings));
    }
}

fn bind(settings: &ServerSettings) -> std::io::Result<std::net::TcpListener> {
    let ip = if settings.listen_all { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let listener = std::net::TcpListener::bind(SocketAddr::from((ip, settings.port)))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

fn install(app: &AppHandle, shared: &Arc<Shared>, settings: &ServerSettings, bound: std::io::Result<std::net::TcpListener>) {
    let mut state = shared.listener.lock().unwrap();
    match bound {
        Ok(listener) => {
            let host = if settings.listen_all { "0.0.0.0" } else { "127.0.0.1" };
            state.address = Some(format!("http://{host}:{}", settings.port));
            let router = router(Api { shared: shared.clone(), app: app.clone() });
            state.task = Some(tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => {
                        if let Err(error) = axum::serve(listener, router).await {
                            eprintln!("Inpaint API server stopped: {error}");
                        }
                    }
                    Err(error) => eprintln!("Inpaint API server could not start: {error}"),
                }
            }));
        }
        Err(error) => state.error = Some(format!("Cannot listen on port {}: {error}", settings.port)),
    }
}

async fn restart(app: &AppHandle, shared: &Arc<Shared>) {
    let previous = {
        let mut listener = shared.listener.lock().unwrap();
        listener.address = None;
        listener.error = None;
        listener.task.take()
    };
    let replacing = previous.is_some();
    // Aborting stops accepting connections; requests already running still finish.
    if let Some(task) = previous {
        task.abort();
    }
    let settings = shared.settings();
    if !settings.enabled {
        return;
    }
    let mut attempts = 0;
    let bound = loop {
        match bind(&settings) {
            // The aborted task releases its port once the runtime drops it.
            Err(error) if replacing && error.kind() == ErrorKind::AddrInUse && attempts < 20 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            result => break result,
        }
    };
    install(app, shared, &settings, bound);
}

#[tauri::command]
pub fn server_status(state: tauri::State<'_, ServerState>) -> ServerStatus {
    state.0.status()
}

#[tauri::command]
pub async fn server_configure(
    app: AppHandle,
    state: tauri::State<'_, ServerState>,
    settings: ServerSettings,
) -> Result<ServerStatus, String> {
    let shared = state.0.clone();
    let _configuring = shared.configuring.lock().await;
    let settings = normalize_settings(settings)?;
    save_settings(&settings)?;
    *shared.settings.lock().unwrap() = settings;
    restart(&app, &shared).await;
    status_changed(&app);
    Ok(shared.status())
}

/// Starts or stops the server with the saved settings, for the tray menu.
pub async fn set_enabled(app: &AppHandle, enabled: bool) {
    let shared = app.state::<ServerState>().0.clone();
    let _configuring = shared.configuring.lock().await;
    let settings = {
        let mut settings = shared.settings.lock().unwrap();
        settings.enabled = enabled;
        settings.clone()
    };
    if let Err(error) = save_settings(&settings) {
        eprintln!("{error}");
    }
    restart(app, &shared).await;
    status_changed(app);
}

/// Whether the server is listening, and why it could not start.
pub fn summary(app: &AppHandle) -> (bool, Option<String>) {
    let status = app.state::<ServerState>().0.status();
    (status.running, status.error)
}

// The settings dialog and the tray show the server state; both follow changes made in the other.
fn status_changed(app: &AppHandle) {
    let _ = app.emit("server-status", ());
    super::tray::refresh(app);
}

#[tauri::command]
pub fn server_new_token() -> String {
    new_token()
}

#[tauri::command]
pub fn server_bridge(state: tauri::State<'_, ServerState>, ready: bool) {
    if ready {
        state.0.bridges.fetch_add(1, Ordering::SeqCst);
    } else {
        state.0.bridges.fetch_sub(1, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn server_take_job(state: tauri::State<'_, ServerState>, id: u64) -> Option<Value> {
    state.0.jobs.lock().unwrap().get_mut(&id).and_then(|job| job.input.take())
}

#[tauri::command]
pub fn server_job_result(state: tauri::State<'_, ServerState>, id: u64, reply: JobReply) {
    if let Some(job) = state.0.jobs.lock().unwrap().remove(&id) {
        let _ = job.reply.send(reply);
    }
}

#[derive(Clone)]
struct Api {
    shared: Arc<Shared>,
    app: AppHandle,
}

fn router(api: Api) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/operations", get(operations))
        .route("/workflows", get(workflows))
        .route("/workflow/{id}", post(run_workflow))
        .route("/face-source", get(face_source))
        .route("/load", post(load))
        .route("/save", post(save))
        .route("/{operation}", post(run_operation))
        .fallback(not_found)
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "Wrong HTTP method. /health, /operations, /workflows and /face-source take GET; operations, workflows, /load and /save take POST.",
            )
        })
        .layer(middleware::from_fn_with_state(api.clone(), authorize))
        .layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES))
        .with_state(api)
}

struct ApiError(StatusCode, String);

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "ok": false, "error": self.1 }))).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message)
}

fn internal(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn missing_image() -> ApiError {
    bad_request(format!("Send \"image\". {SOURCE_HELP} Raw image bytes are accepted as the request body."))
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Unknown endpoint. GET /operations lists the endpoints.")
}

async fn authorize(State(api): State<Api>, request: Request, next: Next) -> Response {
    let settings = api.shared.settings();
    let headers = request.headers();
    // A web page that points its own hostname at 127.0.0.1 (DNS rebinding) still sends that hostname.
    if !settings.listen_all && !is_loopback_host(headers) {
        return ApiError::new(StatusCode::FORBIDDEN, "Address the server as 127.0.0.1 or localhost.").into_response();
    }
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| headers.get("x-inpaint-token").and_then(|value| value.to_str().ok()));
    if !supplied.is_some_and(|token| same_token(token.trim().as_bytes(), settings.token.as_bytes())) {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Send the access token from Inpaint's API server settings as \"Authorization: Bearer <token>\".",
        )
        .into_response();
    }
    next.run(request).await
}

fn is_loopback_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(name.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost")
}

fn same_token(supplied: &[u8], expected: &[u8]) -> bool {
    supplied.len() == expected.len()
        && supplied.iter().zip(expected).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Source {
    Text(String),
    Path { path: String },
    Url { url: String },
    Data { data: String },
    #[serde(skip)]
    Bytes(Vec<u8>),
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ApiRequest {
    image: Option<Source>,
    mask: Option<Source>,
    donor: Option<Source>,
    background: Option<Source>,
    options: Map<String, Value>,
    write: bool,
    output_path: Option<String>,
    format: Option<String>,
    name: Option<String>,
    path: Option<String>,
}

/// Accepts a JSON body, or raw image bytes with everything else in the query string.
fn parse_request(headers: &HeaderMap, query: HashMap<String, String>, body: Bytes) -> Result<ApiRequest, ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // curl -d sends JSON as a form unless told otherwise, so also look at the body.
    let json_body = content_type.starts_with("application/json")
        || (!content_type.starts_with("image/") && body.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{'));
    if json_body {
        return serde_json::from_slice(&body).map_err(|error| bad_request(format!("Invalid JSON body: {error}")));
    }
    let mut request = ApiRequest::default();
    if !body.is_empty() {
        request.image = Some(Source::Bytes(body.to_vec()));
    }
    for (key, value) in query {
        match key.as_str() {
            "image" => request.image = Some(Source::Text(value)),
            "mask" => request.mask = Some(Source::Text(value)),
            "donor" => request.donor = Some(Source::Text(value)),
            "background" => request.background = Some(Source::Text(value)),
            "write" => request.write = matches!(value.as_str(), "true" | "1"),
            "outputPath" => request.output_path = Some(value),
            "format" => request.format = Some(value),
            "name" => request.name = Some(value),
            "path" => request.path = Some(value),
            "options" => match serde_json::from_str(&value) {
                Ok(Value::Object(options)) => request.options.extend(options),
                _ => return Err(bad_request("\"options\" must be a JSON object.")),
            },
            _ => {
                request.options.insert(key, query_value(&value));
            }
        }
    }
    Ok(request)
}

fn query_value(value: &str) -> Value {
    match value {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(|number| json!(number))
            .or_else(|| value.starts_with('[').then(|| serde_json::from_str(value).ok()).flatten())
            .unwrap_or_else(|| Value::String(value.to_string())),
    }
}

struct Picture {
    /// PNG, JPEG or WebP bytes with the pixels upright.
    bytes: Vec<u8>,
    mime: &'static str,
    /// The bytes as received, kept when they had to be rotated or converted.
    received: Option<Vec<u8>>,
    received_mime: &'static str,
    path: Option<PathBuf>,
    name: String,
}

impl Picture {
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, BASE64.encode(&self.bytes))
    }

    fn metadata(&self) -> &[u8] {
        self.received.as_deref().unwrap_or(&self.bytes)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| internal(format!("Background task failed: {error}")))?
}

fn is_http(text: &str) -> bool {
    let lower = text.get(..8).unwrap_or(text).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

async fn resolve(api: &Api, source: Source) -> Result<Picture, ApiError> {
    let settings = api.shared.settings();
    let source = match source {
        Source::Text(text) if text.starts_with("data:") => Source::Data { data: text },
        Source::Text(text) if is_http(&text) => Source::Url { url: text },
        Source::Text(text) if text.starts_with('/') => Source::Path { path: text },
        other => other,
    };
    let (bytes, path, name) = match source {
        Source::Text(_) => return Err(bad_request(SOURCE_HELP)),
        Source::Bytes(bytes) => (bytes, None, None),
        Source::Data { data } => (decode_base64(&data)?, None, None),
        Source::Path { path } => {
            let path = allowed_path(&settings, &path, true)?;
            let reading = path.clone();
            let bytes = blocking(move || {
                fs::read(&reading).map_err(|error| {
                    ApiError::new(StatusCode::NOT_FOUND, format!("Cannot read {}: {error}", reading.display()))
                })
            })
            .await?;
            let name = path.file_name().map(|name| name.to_string_lossy().into_owned());
            (bytes, Some(path), name)
        }
        Source::Url { url } => {
            if !settings.allow_urls {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "URL downloads are turned off in Inpaint's API server settings."));
            }
            if !is_http(&url) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(bad_request("Only http(s) URLs can be downloaded."));
            }
            let name = url
                .split(['?', '#'])
                .next()
                .and_then(|address| address.rsplit('/').next())
                .filter(|name| !name.is_empty() && !name.contains(':'))
                .map(str::to_string);
            let bytes = blocking(move || download(&url).map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error))).await?;
            (bytes, None, name)
        }
    };
    let picture = blocking(move || {
        normalize_image(bytes).map_err(|error| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, error))
    })
    .await?;
    let (bytes, mime, received, received_mime) = picture;
    Ok(Picture { name: file_name(name.as_deref(), mime), bytes, mime, received, received_mime, path })
}

fn decode_base64(data: &str) -> Result<Vec<u8>, ApiError> {
    let encoded = if data.starts_with("data:") {
        data.split_once(',').map(|(_, payload)| payload).ok_or_else(|| bad_request("Invalid data URL."))?
    } else {
        data
    };
    BASE64.decode(encoded.trim()).map_err(|error| bad_request(format!("Invalid base64 image: {error}")))
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    super::http::download_to(url, "image/*,*/*;q=0.8", std::time::Duration::from_secs(120), MAX_IMAGE_BYTES as u64, &mut bytes)?;
    Ok(bytes)
}

type Normalized = (Vec<u8>, &'static str, Option<Vec<u8>>, &'static str);

/// Rotates camera pictures upright and converts formats the editor cannot read,
/// so the webview and the Python models see the same pixels.
fn normalize_image(bytes: Vec<u8>) -> Result<Normalized, String> {
    let format = image::guess_format(&bytes).map_err(|_| "The data is not a supported image.".to_string())?;
    let mut decoder = image::ImageReader::with_format(Cursor::new(&bytes), format)
        .into_decoder()
        .map_err(|error| format!("Cannot read the image: {error}"))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mime = match format {
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::WebP => Some("image/webp"),
        _ => None,
    };
    if let (Some(mime), Orientation::NoTransforms) = (mime, orientation) {
        drop(decoder);
        return Ok((bytes, mime, None, mime));
    }
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| format!("Cannot decode the image: {error}"))?;
    image.apply_orientation(orientation);
    let png = super::encode_image(&image, ImageFormat::Png)?;
    Ok((png, "image/png", Some(bytes), mime.unwrap_or("image/png")))
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// A safe file name. A picture extension in `name` is kept, since saving converts to it.
fn file_name(name: Option<&str>, mime: &str) -> String {
    let cleaned: String = name
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\'))
        .take(200)
        .collect();
    let path = Path::new(cleaned.trim());
    if super::image_extension(path).is_some() && path.file_stem().is_some_and(|stem| !stem.is_empty()) {
        return cleaned.trim().to_string();
    }
    let stem = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).filter(|stem| !stem.is_empty() && stem != "..");
    format!("{}.{}", stem.unwrap_or_else(|| "image".into()), extension_for(mime))
}

/// Resolves a disk path and checks it lies inside a folder allowed in the API server settings.
fn allowed_path(settings: &ServerSettings, raw: &str, existing: bool) -> Result<PathBuf, ApiError> {
    let requested = Path::new(raw);
    if !requested.is_absolute() {
        return Err(bad_request("Disk paths must be absolute."));
    }
    let resolved = if existing || requested.exists() {
        fs::canonicalize(requested)
            .map_err(|error| ApiError::new(StatusCode::NOT_FOUND, format!("Cannot open {raw}: {error}")))?
    } else {
        let (Some(parent), Some(name)) = (requested.parent(), requested.file_name()) else {
            return Err(bad_request("Invalid path."));
        };
        fs::canonicalize(parent)
            .map_err(|error| ApiError::new(StatusCode::NOT_FOUND, format!("Cannot open folder {}: {error}", parent.display())))?
            .join(name)
    };
    if super::image_extension(&resolved).is_none() {
        return Err(bad_request("Only .png, .jpg, .jpeg and .webp files are supported."));
    }
    let allowed = settings
        .allowed_folders
        .iter()
        .filter_map(|folder| fs::canonicalize(folder).ok())
        .any(|folder| resolved.starts_with(folder));
    if !allowed {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("{} is outside the folders the API may read and write. Add its folder in Inpaint's API server settings.", resolved.display()),
        ));
    }
    Ok(resolved)
}

fn asset_path(picture: &Picture, directory: &Path, stem: &str) -> Result<String, ApiError> {
    if let Some(path) = &picture.path {
        return Ok(path.to_string_lossy().into_owned());
    }
    let path = directory.join(format!("{stem}.{}", extension_for(picture.mime)));
    fs::write(&path, &picture.bytes).map_err(|error| internal(format!("Cannot prepare the {stem} image: {error}")))?;
    Ok(path.to_string_lossy().into_owned())
}

async fn bridge(api: &Api, mut input: Value) -> Result<JobReply, ApiError> {
    if api.shared.bridges.load(Ordering::SeqCst) <= 0 {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Inpaint is not ready. Finish the runtime setup and keep the app open.",
        ));
    }
    let id = api.shared.next_job.fetch_add(1, Ordering::SeqCst) + 1;
    input["id"] = json!(id);
    let (reply, receiver) = oneshot::channel();
    api.shared.jobs.lock().unwrap().insert(id, Job { input: Some(input), reply });
    let _pending = PendingJob { shared: api.shared.clone(), id };
    api.app
        .emit("server-job", json!({ "id": id }))
        .map_err(|error| internal(format!("Cannot reach the app window: {error}")))?;
    let reply = match tokio::time::timeout(JOB_TIMEOUT, receiver).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => return Err(internal("The app window dropped the job.")),
        Err(_) => return Err(ApiError::new(StatusCode::GATEWAY_TIMEOUT, "The job did not finish within an hour.")),
    };
    if reply.ok {
        return Ok(reply);
    }
    let status = reply.status.and_then(|status| StatusCode::from_u16(status).ok());
    Err(ApiError::new(
        status.unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        reply.error.unwrap_or_else(|| "The operation failed.".into()),
    ))
}

/// Forgets a job when its request ends early, for example when the client disconnects.
struct PendingJob {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for PendingJob {
    fn drop(&mut self) {
        self.shared.jobs.lock().unwrap().remove(&self.id);
    }
}

fn endpoints() -> Value {
    json!([
        { "method": "GET", "path": "/health", "description": "App status. \"ready\" is false until the window can run jobs." },
        { "method": "GET", "path": "/operations", "description": "Endpoints and every operation's options with defaults." },
        { "method": "POST", "path": "/{operation}", "description": "Run an operation on \"image\". Returns the image, or writes it with \"write\" or \"outputPath\"." },
        { "method": "GET", "path": "/workflows", "description": "Workflows saved in the app." },
        { "method": "POST", "path": "/workflow/{id-or-name}", "description": "Run every step of a saved workflow on \"image\"." },
        { "method": "GET", "path": "/face-source", "description": "The face source photo selected in Inpaint, which face-swap uses without a \"donor\"." },
        { "method": "POST", "path": "/load", "description": "Open \"image\" in the editor. Save overwrites disk paths and asks where to save anything else." },
        { "method": "POST", "path": "/save", "description": "Write \"image\" to \"path\", or without a path add it to the save folder under a new name." }
    ])
}

async fn health(State(api): State<Api>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "app": "inpaint",
        "version": env!("CARGO_PKG_VERSION"),
        "ready": api.shared.bridges.load(Ordering::SeqCst) > 0,
    }))
}

async fn operations(State(api): State<Api>) -> ApiResult {
    let reply = bridge(&api, json!({ "kind": "operations" })).await?;
    Ok(Json(json!({ "ok": true, "endpoints": endpoints(), "operations": reply.data })).into_response())
}

async fn workflows(State(api): State<Api>) -> ApiResult {
    let reply = bridge(&api, json!({ "kind": "workflows" })).await?;
    Ok(Json(json!({ "ok": true, "workflows": reply.data })).into_response())
}

async fn face_source(State(api): State<Api>) -> ApiResult {
    let reply = bridge(&api, json!({ "kind": "face-source" })).await?;
    Ok(Json(json!({ "ok": true, "faceSource": reply.data })).into_response())
}

async fn run_operation(
    State(api): State<Api>,
    UrlPath(operation): UrlPath<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let request = parse_request(&headers, query, body)?;
    process(&api, request, json!({ "kind": "operation", "name": operation })).await
}

async fn run_workflow(
    State(api): State<Api>,
    UrlPath(workflow): UrlPath<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let request = parse_request(&headers, query, body)?;
    process(&api, request, json!({ "kind": "workflow", "name": workflow })).await
}

async fn process(api: &Api, mut request: ApiRequest, mut input: Value) -> ApiResult {
    let image = resolve(api, request.image.take().ok_or_else(missing_image)?).await?;
    let target = match (&request.output_path, request.write) {
        (Some(path), _) => Some(allowed_path(&api.shared.settings(), path, false)?),
        (None, true) => Some(image.path.clone().ok_or_else(|| {
            bad_request("\"write\" needs an image sent as a disk path. Use \"outputPath\" to write somewhere else.")
        })?),
        (None, false) => None,
    };
    // Donor and background images are read by the Python worker from disk.
    let assets = tempfile::Builder::new()
        .prefix("inpaint-api-")
        .tempdir()
        .map_err(|error| internal(format!("Cannot create a temporary folder: {error}")))?;
    if let Some(mask) = request.mask.take() {
        input["mask"] = json!(resolve(api, mask).await?.data_url());
    }
    if let Some(donor) = request.donor.take() {
        input["donorPath"] = json!(asset_path(&resolve(api, donor).await?, assets.path(), "donor")?);
    }
    if let Some(background) = request.background.take() {
        input["backgroundPath"] = json!(asset_path(&resolve(api, background).await?, assets.path(), "background")?);
    }
    input["options"] = Value::Object(std::mem::take(&mut request.options));
    input["image"] = json!(image.data_url());
    input["fileName"] = json!(image.name);

    let reply = bridge(api, input).await?;
    let result = match (reply.image, reply.data) {
        (Some(result), _) => result,
        (None, Some(data)) => return Ok(Json(json!({ "ok": true, "data": data })).into_response()),
        (None, None) => return Err(internal("The operation returned no result.")),
    };
    let requested_format = request.format;
    blocking(move || {
        let decoded = super::decode_data_url(&result)
            .and_then(|bytes| image::load_from_memory(&bytes).map_err(|error| error.to_string()))
            .map_err(|error| internal(format!("Cannot read the result: {error}")))?;
        let (width, height) = (decoded.width(), decoded.height());
        if let Some(target) = target {
            let format = super::image_format_for(&target).map_err(bad_request)?;
            let encoded = super::copy_metadata(super::encode_image(&decoded, format).map_err(internal)?, image.metadata());
            super::replace_file(&target, &encoded).map_err(internal)?;
            return Ok(Json(json!({ "ok": true, "path": target, "width": width, "height": height, "bytes": encoded.len() })).into_response());
        }
        let format = output_format(requested_format.as_deref(), image.received_mime, &decoded)?;
        let encoded = super::copy_metadata(super::encode_image(&decoded, format).map_err(internal)?, image.metadata());
        let mut response = encoded.into_response();
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(format.to_mime_type()));
        headers.insert(HeaderName::from_static("x-image-width"), HeaderValue::from(width));
        headers.insert(HeaderName::from_static("x-image-height"), HeaderValue::from(height));
        Ok(response)
    })
    .await
}

fn output_format(requested: Option<&str>, received_mime: &str, image: &DynamicImage) -> Result<ImageFormat, ApiError> {
    match requested.unwrap_or("auto").to_ascii_lowercase().as_str() {
        "png" => Ok(ImageFormat::Png),
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        "webp" => Ok(ImageFormat::WebP),
        // JPEG stays JPEG unless the result gained transparency.
        "auto" if received_mime == "image/jpeg" && is_opaque(image) => Ok(ImageFormat::Jpeg),
        "auto" => Ok(ImageFormat::Png),
        other => Err(bad_request(format!("Unsupported format \"{other}\". Use png, jpeg, webp or auto."))),
    }
}

fn is_opaque(image: &DynamicImage) -> bool {
    !image.color().has_alpha() || image.to_rgba8().pixels().all(|pixel| pixel[3] == u8::MAX)
}

async fn load(
    State(api): State<Api>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let mut request = parse_request(&headers, query, body)?;
    // "path" is the file Save overwrites, for pictures sent as bytes or edited since they were read.
    let save_path = request.path.take().map(|path| allowed_path(&api.shared.settings(), &path, false)).transpose()?;
    let image = resolve(&api, request.image.take().ok_or_else(missing_image)?).await?;
    let save_path = save_path.or_else(|| image.path.clone());
    let name = match (request.name.as_deref(), &save_path) {
        (Some(name), _) => file_name(Some(name), image.mime),
        (None, Some(path)) => file_name(path.file_name().and_then(|name| name.to_str()), image.mime),
        (None, None) => image.name.clone(),
    };
    bridge(&api, json!({ "kind": "load", "image": image.data_url(), "sourcePath": save_path, "fileName": name })).await?;
    super::tray::show_window(&api.app);
    Ok(Json(json!({ "ok": true })).into_response())
}

/// With "path", replaces that file. Without it, adds a new file to the save folder.
async fn save(
    State(api): State<Api>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let mut request = parse_request(&headers, query, body)?;
    let settings = api.shared.settings();
    let target = request.path.take().map(|path| allowed_path(&settings, &path, false)).transpose()?;
    let image = resolve(&api, request.image.take().ok_or_else(missing_image)?).await?;
    let name = request.name.as_deref().map_or_else(|| image.name.clone(), |name| file_name(Some(name), image.mime));
    let folder = settings.save_folder();
    blocking(move || {
        let (path, existing) = match &target {
            Some(path) => (path.clone(), fs::read(path).ok()),
            None => (folder.join(&name), None),
        };
        let format = super::image_format_for(&path).map_err(bad_request)?;
        // Bytes that already have the file's format are stored as sent, avoiding another lossy encode.
        let unchanged = image.received.is_none() && image::guess_format(&image.bytes).ok() == Some(format);
        let encoded = if unchanged {
            image.bytes.clone()
        } else {
            let decoded = image::load_from_memory(&image.bytes)
                .map_err(|error| bad_request(format!("Cannot decode the image: {error}")))?;
            super::encode_image(&decoded, format).map_err(internal)?
        };
        let encoded = match existing.as_deref().or((!unchanged).then(|| image.metadata())) {
            Some(metadata) => super::copy_metadata(encoded, metadata),
            None => encoded,
        };
        let path = match target {
            Some(path) => {
                super::replace_file(&path, &encoded).map_err(internal)?;
                path
            }
            None => store_new_file(&folder, &name, &encoded)?,
        };
        let (width, height) = image::ImageReader::new(Cursor::new(&encoded))
            .with_guessed_format()
            .ok()
            .and_then(|reader| reader.into_dimensions().ok())
            .unwrap_or_default();
        Ok(Json(json!({ "ok": true, "path": path, "width": width, "height": height, "bytes": encoded.len() })).into_response())
    })
    .await
}

/// Writes a new file in `folder`, numbering the name instead of overwriting another picture.
fn store_new_file(folder: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, ApiError> {
    use std::{io::Write, os::unix::fs::PermissionsExt};
    fs::create_dir_all(folder).map_err(|error| internal(format!("Cannot create {}: {error}", folder.display())))?;
    let failed = |error: std::io::Error| internal(format!("Cannot save in {}: {error}", folder.display()));
    let mut file = tempfile::Builder::new().prefix(".inpaint-save-").tempfile_in(folder).map_err(failed)?;
    file.write_all(bytes).map_err(failed)?;
    file.as_file().set_permissions(fs::Permissions::from_mode(0o644)).map_err(failed)?;
    file.as_file().sync_all().map_err(failed)?;
    let path = Path::new(name);
    let stem = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let extension = path.extension().map(|extension| extension.to_string_lossy().into_owned()).unwrap_or_else(|| "png".into());
    for index in 0..10_000 {
        let candidate = folder.join(if index == 0 { format!("{stem}.{extension}") } else { format!("{stem}_{index}.{extension}") });
        match file.persist_noclobber(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(error) if error.error.kind() == ErrorKind::AlreadyExists => file = error.file,
            Err(error) => return Err(failed(error.error)),
        }
    }
    Err(internal("Too many pictures with the same name in the save folder."))
}
