//! Immich connection for image stores marked Immich compatible. After the editor saves a
//! picture in such a store, Immich is asked to rebuild the asset's thumbnail. Upload file
//! names are not asset IDs, so the asset is found through its original path.

use super::{http::AGENT, stores::Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};

const TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImmichSettings {
    pub url: String,
    pub api_key: String,
}

fn load_settings() -> ImmichSettings {
    super::db::setting("immich").and_then(Result::ok).unwrap_or_default()
}

#[tauri::command]
pub fn immich_settings() -> ImmichSettings {
    load_settings()
}

#[tauri::command]
pub fn immich_configure(settings: ImmichSettings) -> Result<ImmichSettings, String> {
    let url = settings.url.trim().trim_end_matches('/').trim_end_matches("/api").to_string();
    if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Enter the Immich address starting with http:// or https://.".into());
    }
    let settings = ImmichSettings { url, api_key: settings.api_key.trim().to_string() };
    // Saved in inpaint.db, which only the user can read, so the API key stays private.
    super::db::set_setting("immich", &settings)?;
    Ok(settings)
}

#[tauri::command]
pub async fn immich_test() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = load_settings();
        if settings.url.is_empty() || settings.api_key.is_empty() {
            return Err("Enter the Immich address and API key, then save.".to_string());
        }
        let me = request(&settings, "/api/users/me", None)?;
        Ok(match (me["name"].as_str(), me["email"].as_str()) {
            (Some(name), Some(email)) => format!("Connected as {name} ({email})."),
            _ => "Connected to Immich.".to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

enum Payload<'a> {
    Empty,
    Json(&'a Value),
    /// A multipart form body with its boundary.
    Form(String, Vec<u8>),
}

/// Calls the Immich API. When Immich refuses a request, its own message is kept.
fn call(settings: &ImmichSettings, method: &str, path: &str, payload: Payload, timeout: Duration, headers: &[(&str, &str)]) -> Result<Value, String> {
    let url = format!("{}{path}", settings.url);
    // The same headers and timeout for requests with and without a body, which ureq types apart.
    macro_rules! prepared {
        ($builder:expr) => {{
            let mut builder = $builder.header("x-api-key", settings.api_key.as_str()).header("Accept", "application/json");
            for (name, value) in headers {
                builder = builder.header(*name, *value);
            }
            builder.config().timeout_global(Some(timeout)).build()
        }};
    }
    let (content_type, body) = match payload {
        Payload::Empty => (String::new(), None),
        Payload::Json(value) => ("application/json".to_string(), Some(value.to_string().into_bytes())),
        Payload::Form(boundary, bytes) => (format!("multipart/form-data; boundary={boundary}"), Some(bytes)),
    };
    let response = match (method, body) {
        ("GET", _) => prepared!(AGENT.get(&url)).call(),
        ("DELETE", None) => prepared!(AGENT.delete(&url)).call(),
        ("DELETE", Some(body)) => prepared!(AGENT.delete(&url).force_send_body()).content_type(content_type).send(body),
        ("PUT", body) => prepared!(AGENT.put(&url)).content_type(content_type).send(body.unwrap_or_default()),
        ("POST", body) => prepared!(AGENT.post(&url)).content_type(content_type).send(body.unwrap_or_default()),
        _ => return Err(format!("Unsupported request method {method}.")),
    };
    let mut response = response.map_err(|error| format!("Cannot reach Immich: {error}"))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(64 << 20)
        .read_to_string()
        .map_err(|error| format!("Cannot read Immich's answer: {error}"))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let message = match &value["message"] {
            Value::String(message) => message.clone(),
            Value::Array(messages) => messages.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
            _ => text.trim().chars().take(200).collect(),
        };
        return Err(format!("Immich answered {status}: {message}"));
    }
    Ok(value)
}

/// GET, or POST when there is a body.
fn request(settings: &ImmichSettings, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let method = if body.is_some() { "POST" } else { "GET" };
    send(settings, method, path, body)
}

/// Calls the API with any method, sending `body` as JSON.
fn send(settings: &ImmichSettings, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    call(settings, method, path, body.map_or(Payload::Empty, Payload::Json), TIMEOUT, &[])
}

/// A multipart form with text fields and one file.
fn form_body(boundary: &str, fields: &[(&str, &str)], file: (&str, &str, &[u8])) -> Vec<u8> {
    let (field, file_name, data) = file;
    let mut body = Vec::with_capacity(data.len() + 1024);
    for (name, value) in fields {
        let _ = write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n");
    }
    let _ = write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(data);
    let _ = write!(body, "\r\n--{boundary}--\r\n");
    body
}

fn configured() -> Result<ImmichSettings, String> {
    let settings = load_settings();
    if settings.url.is_empty() || settings.api_key.is_empty() {
        return Err("Add Immich's address and API key in Settings.".into());
    }
    Ok(settings)
}

/// Immich ids are UUIDs; checking them keeps request paths intact.
fn checked_id(id: &str) -> Result<&str, String> {
    if id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        Ok(id)
    } else {
        Err(format!("{id} is not an Immich id."))
    }
}

/// Bulk answers list each id; one already there, or already gone, counts as done.
fn bulk_result(value: &Value) -> Result<(), String> {
    match value.as_array().and_then(|items| items.first()) {
        Some(item) if item["success"] == false && !matches!(item["error"].as_str(), Some("duplicate" | "not_found")) => {
            Err(format!("Immich refused: {}", item["error"].as_str().unwrap_or("unknown error")))
        }
        _ => Ok(()),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDetails {
    id: String,
    url: String,
    asset: Value,
    albums: Value,
}

/// Immich's record of a picture in an Immich-compatible store, with its tags and people, and the albums
/// holding it. None for pictures outside such stores.
#[tauri::command]
pub async fn immich_asset(path: String) -> Result<Option<AssetDetails>, String> {
    blocking(move || {
        let file = PathBuf::from(&path);
        let file = fs::canonicalize(&file).unwrap_or(file);
        let Some(found) = find_asset(&file) else { return Ok(None) };
        let (settings, id) = found.map_err(|error| format!("Cannot read it from Immich: {error}"))?;
        let asset = send(&settings, "GET", &format!("/api/assets/{id}"), None)?;
        let albums = send(&settings, "GET", &format!("/api/albums?assetId={id}"), None)?;
        Ok(Some(AssetDetails { id, url: settings.url, asset, albums }))
    })
    .await
}

#[derive(Serialize)]
pub struct Catalog {
    tags: Value,
    albums: Value,
}

/// Every tag and album the key's account can use.
#[tauri::command]
pub async fn immich_catalog() -> Result<Catalog, String> {
    blocking(|| {
        let settings = configured()?;
        Ok(Catalog { tags: send(&settings, "GET", "/api/tags", None)?, albums: send(&settings, "GET", "/api/albums", None)? })
    })
    .await
}

/// Changes a picture's favorite mark, rating, description or visibility.
#[tauri::command]
pub async fn immich_update(id: String, changes: Value) -> Result<Value, String> {
    blocking(move || {
        let settings = configured()?;
        let Value::Object(fields) = &changes else { return Err("Expected the fields to change.".into()) };
        if let Some(field) = fields.keys().find(|field| !matches!(field.as_str(), "isFavorite" | "rating" | "description" | "visibility")) {
            return Err(format!("{field} cannot be changed here."));
        }
        send(&settings, "PUT", &format!("/api/assets/{}", checked_id(&id)?), Some(&changes))
    })
    .await
}

#[tauri::command]
pub async fn immich_tag(id: String, tag_id: String, add: bool) -> Result<(), String> {
    blocking(move || {
        let settings = configured()?;
        let method = if add { "PUT" } else { "DELETE" };
        bulk_result(&send(&settings, method, &format!("/api/tags/{}/assets", checked_id(&tag_id)?), Some(&json!({ "ids": [checked_id(&id)?] })))?)
    })
    .await
}

/// Creates a tag, with parent tags for names like `Trips/2024`, or returns the one that exists.
#[tauri::command]
pub async fn immich_create_tag(name: String) -> Result<Value, String> {
    blocking(move || {
        let settings = configured()?;
        let name = name.trim().trim_matches('/').to_string();
        if name.is_empty() {
            return Err("Give the tag a name.".into());
        }
        let tags = send(&settings, "PUT", "/api/tags", Some(&json!({ "tags": [name] })))?;
        tags.as_array()
            .and_then(|tags| tags.iter().find(|tag| tag["value"] == name.as_str()).or(tags.last()))
            .cloned()
            .ok_or_else(|| "Immich did not create the tag.".into())
    })
    .await
}

#[tauri::command]
pub async fn immich_album(id: String, album_id: String, add: bool) -> Result<(), String> {
    blocking(move || {
        let settings = configured()?;
        let method = if add { "PUT" } else { "DELETE" };
        bulk_result(&send(&settings, method, &format!("/api/albums/{}/assets", checked_id(&album_id)?), Some(&json!({ "ids": [checked_id(&id)?] })))?)
    })
    .await
}

/// Creates an album holding the picture.
#[tauri::command]
pub async fn immich_create_album(name: String, id: String) -> Result<Value, String> {
    blocking(move || {
        let settings = configured()?;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Give the album a name.".into());
        }
        send(&settings, "POST", "/api/albums", Some(&json!({ "albumName": name, "assetIds": [checked_id(&id)?] })))
    })
    .await
}

#[tauri::command]
pub fn immich_open(id: String) -> Result<(), String> {
    let settings = configured()?;
    Command::new("xdg-open")
        .arg(format!("{}/photos/{}", settings.url, checked_id(&id)?))
        .spawn()
        .map_err(|error| format!("Cannot open Immich: {error}"))?;
    Ok(())
}

pub enum Upload {
    Created(String),
    Duplicate,
}

/// Uploads a picture as a new asset of the key's account. Immich skips pictures whose SHA-1 it has.
pub fn upload(data: &[u8], file_name: &str, sha1: &str, modified: SystemTime) -> Result<Upload, String> {
    let settings = configured().map_err(|_| "Add Immich's address and API key in Settings to save into this store.".to_string())?;
    let date = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let device_asset = format!("inpaint-{sha1}");
    // The boundary holds the file's own hash, so the file cannot contain it.
    let boundary = format!("inpaint-boundary-{sha1}");
    let fields = [("deviceAssetId", device_asset.as_str()), ("deviceId", "inpaint"), ("fileCreatedAt", date.as_str()), ("fileModifiedAt", date.as_str())];
    let body = form_body(&boundary, &fields, ("assetData", file_name, data));
    let asset = call(&settings, "POST", "/api/assets", Payload::Form(boundary, body), UPLOAD_TIMEOUT, &[("x-immich-checksum", sha1)])?;
    let id = asset["id"].as_str().ok_or("Immich did not return the uploaded asset.")?;
    Ok(if asset["status"] == "duplicate" { Upload::Duplicate } else { Upload::Created(id.to_string()) })
}

/// Where an asset's original is on this computer, when it lies in the store folder.
pub fn local_path(store: &Store, id: &str) -> Option<PathBuf> {
    let asset = request(&load_settings(), &format!("/api/assets/{id}"), None).ok()?;
    let original = asset["originalPath"].as_str()?;
    let relative = original.strip_prefix(store.immich_path.trim_end_matches('/'))?.trim_start_matches('/');
    Some(Path::new(&store.path).join(relative)).filter(|path| path.is_file())
}

/// The Immich asset of a picture in an Immich-compatible store, found through its original path.
/// None outside such stores.
fn find_asset(path: &Path) -> Option<Result<(ImmichSettings, String), String>> {
    let store = super::stores::immich_stores().into_iter().find(|store| path.starts_with(&store.path))?;
    let relative = path.strip_prefix(&store.path).ok()?.to_string_lossy().into_owned();
    let settings = load_settings();
    if settings.url.is_empty() || settings.api_key.is_empty() {
        return Some(Err("add Immich's address and API key in Settings".into()));
    }
    let immich_path = format!("{}/{relative}", store.immich_path);
    Some((|| {
        let found = request(&settings, "/api/search/metadata", Some(&json!({ "originalPath": immich_path, "size": 1 })))?;
        let id = found["assets"]["items"][0]["id"]
            .as_str()
            .ok_or_else(|| format!("Immich has no asset at {immich_path}. Check the store's Immich path."))?
            .to_string();
        Ok((settings, id))
    })())
}

/// Asks Immich to rebuild the thumbnail of a saved store picture, and to read its metadata again
/// when its size changed. Returns a note for the editor, or None outside Immich-compatible stores.
pub fn refresh_saved_picture(path: &Path, size_changed: bool) -> Option<String> {
    let result = find_asset(path)?.and_then(|(settings, id)| {
        let jobs: &[&str] = if size_changed { &["regenerate-thumbnail", "refresh-metadata"] } else { &["regenerate-thumbnail"] };
        for name in jobs {
            request(&settings, "/api/assets/jobs", Some(&json!({ "assetIds": [id], "name": name })))?;
        }
        Ok(())
    });
    Some(match result {
        Ok(()) => "Immich is rebuilding the thumbnail.".into(),
        Err(error) => format!("Immich was not updated: {error}"),
    })
}

/// Moves a picture of an Immich-compatible store to Immich's trash, which removes the file when it is
/// emptied. Deleting the file directly would leave Immich with a broken asset. None outside such stores.
pub fn trash_picture(path: &Path) -> Option<Result<String, String>> {
    Some(
        find_asset(path)?
            .and_then(|(settings, id)| {
                send(&settings, "DELETE", "/api/assets", Some(&json!({ "ids": [id], "force": false })))?;
                Ok("Moved to Immich's trash.".to_string())
            })
            .map_err(|error| format!("Immich did not delete it: {error}")),
    )
}

#[cfg(test)]
mod tests {
    use super::{super::http::test_server::*, *};

    fn settings(url: String) -> ImmichSettings {
        ImmichSettings { url, api_key: "secret-key".into() }
    }

    #[test]
    fn requests_carry_the_key_json_and_method() {
        let (base, server) = serve(vec![
            answer("200 OK", &["Content-Type: application/json"], br#"{"id":"x"}"#),
            answer("204 No Content", &[], b""),
        ]);
        let settings = settings(base);
        assert_eq!(send(&settings, "PUT", "/api/assets/1", Some(&json!({ "rating": 4 }))).unwrap()["id"], "x");
        assert_eq!(send(&settings, "DELETE", "/api/assets", Some(&json!({ "ids": ["1"] }))).unwrap(), Value::Null);
        let requests = server.join().unwrap();
        let (put, delete) = (requests[0].to_ascii_lowercase(), requests[1].to_ascii_lowercase());
        assert!(put.starts_with("put /api/assets/1 ") && put.contains("x-api-key: secret-key") && put.contains("content-type: application/json") && put.ends_with(r#"{"rating":4}"#), "{put}");
        assert!(delete.starts_with("delete /api/assets ") && delete.ends_with(r#"{"ids":["1"]}"#), "{delete}");
    }

    #[test]
    fn refusals_keep_immichs_message() {
        let (base, server) = serve(vec![
            answer("400 Bad Request", &["Content-Type: application/json"], br#"{"message":["rating must not be greater than 5","rating must be an integer"]}"#),
            answer("403 Forbidden", &[], b"Missing required permission: tag.asset"),
        ]);
        let settings = settings(base);
        assert_eq!(send(&settings, "PUT", "/api/assets/1", Some(&json!({}))).unwrap_err(), "Immich answered 400: rating must not be greater than 5 rating must be an integer");
        assert_eq!(send(&settings, "GET", "/api/tags", None).unwrap_err(), "Immich answered 403: Missing required permission: tag.asset");
        server.join().unwrap();
        let unreachable = send(&super::ImmichSettings { url: "http://127.0.0.1:9".into(), api_key: "k".into() }, "GET", "/api/tags", None).unwrap_err();
        assert!(unreachable.starts_with("Cannot reach Immich"), "{unreachable}");
    }

    // Read-only calls to the configured Immich:
    // INPAINT_PROJECT_DIR=<checkout> cargo test --lib real_immich -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_immich_answers_through_the_agent() {
        let settings = configured().expect("Immich settings in the project directory");
        let version = send(&settings, "GET", "/api/server/version", None).unwrap();
        println!("Immich {}.{}.{}", version["major"], version["minor"], version["patch"]);
        assert!(send(&settings, "GET", "/api/users/me", None).unwrap()["id"].is_string());
        println!("{} tags", send(&settings, "GET", "/api/tags", None).unwrap().as_array().map_or(0, Vec::len));
        let refused = send(&settings, "GET", "/api/assets/00000000-0000-0000-0000-000000000000", None).unwrap_err();
        println!("{refused}");
        assert!(refused.starts_with("Immich answered 4"), "{refused}");
    }

    #[test]
    fn uploads_are_multipart_forms() {
        let body = form_body("b0", &[("deviceId", "inpaint")], ("assetData", "abc.jpg", b"\x00JPEG"));
        assert_eq!(
            body,
            b"--b0\r\nContent-Disposition: form-data; name=\"deviceId\"\r\n\r\ninpaint\r\n--b0\r\nContent-Disposition: form-data; name=\"assetData\"; filename=\"abc.jpg\"\r\nContent-Type: application/octet-stream\r\n\r\n\x00JPEG\r\n--b0--\r\n"
        );
    }
}
