//! Immich connection for image stores marked Immich compatible. After the editor saves a
//! picture in such a store, Immich is asked to rebuild the asset's thumbnail. Upload file
//! names are not asset IDs, so the asset is found through its original path.

use super::{albums::Album, http::AGENT, stores::Store};
use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use rusqlite::OptionalExtension;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    sync::{
        atomic::{AtomicUsize, Ordering},
        LazyLock, Mutex,
    },
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};

const TIMEOUT: Duration = Duration::from_secs(30);
/// Tags read at the same time while the index is built.
const TAG_THREADS: usize = 8;
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
        ("PATCH", body) => prepared!(AGENT.patch(&url)).content_type(content_type).send(body.unwrap_or_default()),
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

/// The Immich a store belongs to: its own address and key where it has them, else the ones in Settings,
/// so one store can live on another server or use a key of its own.
fn store_settings(store: &Store) -> Result<ImmichSettings, String> {
    let global = load_settings();
    let settings = ImmichSettings {
        url: if store.immich_url.is_empty() { global.url } else { store.immich_url.clone() },
        api_key: if store.immich_key.is_empty() { global.api_key } else { store.immich_key.clone() },
    };
    if settings.url.is_empty() || settings.api_key.is_empty() {
        return Err(format!("Add Immich's address and API key in Settings, or in the store \"{}\".", store.name));
    }
    Ok(settings)
}

/// The store and the Immich it belongs to.
fn store_and_settings(store_id: &str) -> Result<(Store, ImmichSettings), String> {
    let store = super::stores::find_store(store_id)?;
    let settings = store_settings(&store)?;
    Ok((store, settings))
}

/// The Immich to use for a picture's own store, or the one in Settings outside stores.
fn settings_of_store(store_id: Option<&str>) -> Result<ImmichSettings, String> {
    match store_id {
        Some(id) => store_and_settings(id).map(|(_, settings)| settings),
        None => configured(),
    }
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
pub async fn immich_catalog(store_id: Option<String>) -> Result<Catalog, String> {
    blocking(move || {
        let settings = settings_of_store(store_id.as_deref())?;
        Ok(Catalog { tags: send(&settings, "GET", "/api/tags", None)?, albums: send(&settings, "GET", "/api/albums", None)? })
    })
    .await
}

/// Changes a picture's favorite mark, rating, description or visibility.
#[tauri::command]
pub async fn immich_update(id: String, changes: Value, store_id: Option<String>) -> Result<Value, String> {
    blocking(move || {
        let settings = settings_of_store(store_id.as_deref())?;
        let Value::Object(fields) = &changes else { return Err("Expected the fields to change.".into()) };
        if let Some(field) = fields.keys().find(|field| !matches!(field.as_str(), "isFavorite" | "rating" | "description" | "visibility")) {
            return Err(format!("{field} cannot be changed here."));
        }
        send(&settings, "PUT", &format!("/api/assets/{}", checked_id(&id)?), Some(&changes))
    })
    .await
}

#[tauri::command]
pub async fn immich_tag(id: String, tag_id: String, add: bool, store_id: Option<String>) -> Result<(), String> {
    blocking(move || {
        let settings = settings_of_store(store_id.as_deref())?;
        let method = if add { "PUT" } else { "DELETE" };
        bulk_result(&send(&settings, method, &format!("/api/tags/{}/assets", checked_id(&tag_id)?), Some(&json!({ "ids": [checked_id(&id)?] })))?)
    })
    .await
}

/// Creates a tag, with parent tags for names like `Trips/2024`, or returns the one that exists.
#[tauri::command]
pub async fn immich_create_tag(name: String, store_id: Option<String>) -> Result<Value, String> {
    blocking(move || {
        let settings = settings_of_store(store_id.as_deref())?;
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
pub async fn immich_album(id: String, album_id: String, add: bool, store_id: Option<String>) -> Result<(), String> {
    blocking(move || {
        let settings = settings_of_store(store_id.as_deref())?;
        let method = if add { "PUT" } else { "DELETE" };
        bulk_result(&send(&settings, method, &format!("/api/albums/{}/assets", checked_id(&album_id)?), Some(&json!({ "ids": [checked_id(&id)?] })))?)
    })
    .await
}

/// Creates an album holding the picture.
#[tauri::command]
pub async fn immich_create_album(name: String, id: String, store_id: Option<String>) -> Result<Value, String> {
    blocking(move || {
        let settings = settings_of_store(store_id.as_deref())?;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Give the album a name.".into());
        }
        send(&settings, "POST", "/api/albums", Some(&json!({ "albumName": name, "assetIds": [checked_id(&id)?] })))
    })
    .await
}

/// The id of an album that is only a part of other albums' names, such as `Trips` when Immich holds
/// `Trips/Rome`. It is never sent to Immich, which has no album of its own for it.
const GROUPING: &str = "path:";

fn grouping_prefix(album_id: &str) -> Option<&str> {
    album_id.strip_prefix(GROUPING).filter(|prefix| !prefix.is_empty())
}

fn last_part(name: &str) -> String {
    name.rsplit('/').next().unwrap_or(name).to_string()
}

/// True for an album at, or inside, `prefix`.
fn inside(name: &str, prefix: &str) -> bool {
    let (name, prefix) = (name.to_lowercase(), prefix.to_lowercase());
    name == prefix || name.starts_with(&format!("{prefix}/"))
}

/// Reads Immich's flat albums as a tree, the way its tags read: an album named `Trips/2024/Rome` is the
/// album `Rome` inside `2024` inside `Trips`, and each part above it that has no album of its own
/// becomes a grouping album, which only gathers what lies below it.
fn album_tree(store_id: &str, albums: &[Value]) -> Vec<Album> {
    let mut nodes: Vec<Album> = Vec::new();
    let mut by_path: HashMap<String, String> = HashMap::new();
    for album in albums {
        let (Some(id), Some(name)) = (album["id"].as_str(), album["albumName"].as_str()) else { continue };
        let full_name = name.trim().trim_matches('/').to_string();
        if id.is_empty() || full_name.is_empty() {
            continue;
        }
        let count = album["assetCount"].as_u64().unwrap_or(0);
        by_path.entry(full_name.to_lowercase()).or_insert_with(|| id.to_string());
        nodes.push(Album {
            id: id.to_string(),
            store_id: store_id.to_string(),
            name: last_part(&full_name),
            full_name,
            cover_asset_id: album["albumThumbnailAssetId"].as_str().unwrap_or_default().to_string(),
            count,
            total: count,
            ..Default::default()
        });
    }
    // The parts above each album, for the ones Immich has no album for.
    let paths: Vec<String> = nodes.iter().map(|album| album.full_name.clone()).collect();
    for path in paths {
        let parts: Vec<&str> = path.split('/').collect();
        for depth in 1..parts.len() {
            let prefix = parts[..depth].join("/");
            if by_path.contains_key(&prefix.to_lowercase()) {
                continue;
            }
            by_path.insert(prefix.to_lowercase(), format!("{GROUPING}{prefix}"));
            nodes.push(Album {
                id: format!("{GROUPING}{prefix}"),
                store_id: store_id.to_string(),
                name: last_part(&prefix),
                full_name: prefix,
                is_virtual: true,
                ..Default::default()
            });
        }
    }
    // Every album knows the album holding it, and counts and shows what lies below it.
    let counted: Vec<(String, u64)> = nodes.iter().map(|album| (album.full_name.clone(), album.count)).collect();
    let covers: Vec<(String, String)> = nodes.iter().map(|album| (album.full_name.clone(), album.cover_asset_id.clone())).collect();
    for album in &mut nodes {
        album.parent_id = match album.full_name.rsplit_once('/') {
            Some((parent, _)) => by_path.get(&parent.to_lowercase()).cloned().unwrap_or_default(),
            None => String::new(),
        };
        album.total = counted.iter().filter(|(name, _)| inside(name, &album.full_name)).map(|(_, count)| count).sum();
        if album.cover_asset_id.is_empty() {
            if let Some((_, cover)) = covers.iter().find(|(name, cover)| !cover.is_empty() && inside(name, &album.full_name)) {
                album.cover_asset_id = cover.clone();
            }
        }
    }
    nodes.sort_by(|a, b| a.full_name.to_lowercase().cmp(&b.full_name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    nodes
}

/// Immich's albums shown as the store's albums, with names holding `/` read as a tree. The cover is an
/// asset the sidebar resolves to a file of the store with `immich_album_cover`.
#[tauri::command]
pub async fn immich_albums(store_id: String) -> Result<Vec<Album>, String> {
    blocking(move || {
        let (store, settings) = store_and_settings(&store_id)?;
        let albums = send(&settings, "GET", "/api/albums", None)?;
        let albums = albums.as_array().ok_or("Immich did not list the albums.")?;
        Ok(album_tree(&store.id, albums))
    })
    .await
}

/// Immich answers a search with at most this many assets, so a large album is read page by page.
const SEARCH_PAGE: u32 = 1000;
const MAX_SEARCH_PAGES: u32 = 100;

/// Where an album's pictures are, as Immich's original paths. Immich's own album endpoint answers
/// without its assets, so they are searched for instead.
fn album_originals(settings: &ImmichSettings, album_id: &str) -> Result<Vec<String>, String> {
    let mut originals = Vec::new();
    let mut page = 1;
    while page <= MAX_SEARCH_PAGES {
        let body = json!({ "albumIds": [album_id], "size": SEARCH_PAGE, "page": page });
        let found = send(settings, "POST", "/api/search/metadata", Some(&body))?;
        let items = found["assets"]["items"].as_array().map(Vec::as_slice).unwrap_or_default();
        originals.extend(items.iter().filter_map(|asset| asset["originalPath"].as_str().map(str::to_string)));
        // The next page arrives as text, and is missing on the last one.
        let next = found["assets"]["nextPage"].as_str().and_then(|value| value.parse::<u32>().ok()).or_else(|| found["assets"]["nextPage"].as_u64().map(|value| value as u32));
        match next {
            Some(value) if value > page => page = value,
            _ => break,
        }
    }
    Ok(originals)
}

/// Every asset's favourite, rating and upload time, by its file on this computer, page by page.
pub fn asset_facts(store: &Store) -> Result<HashMap<String, super::pictures::Facts>, String> {
    let settings = store_settings(store)?;
    let mut facts = HashMap::new();
    let mut page = 1;
    // Far more pages than album pictures: a whole library.
    while page <= MAX_SEARCH_PAGES * 10 {
        let body = json!({ "size": SEARCH_PAGE, "page": page, "withExif": true });
        let found = send(&settings, "POST", "/api/search/metadata", Some(&body))?;
        for asset in found["assets"]["items"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let Some(path) = asset["originalPath"].as_str().and_then(|original| store_path(store, original)) else { continue };
            let added_ms = asset["createdAt"].as_str().and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok()).map(|time| time.timestamp_millis());
            facts.insert(path, super::pictures::Facts {
                favorite: asset["isFavorite"].as_bool().unwrap_or(false),
                // Immich writes -1 for a rejected picture.
                rating: asset["exifInfo"]["rating"].as_i64().unwrap_or(0).clamp(0, 5) as u8,
                added_ms,
            });
        }
        let next = found["assets"]["nextPage"].as_str().and_then(|value| value.parse::<u32>().ok()).or_else(|| found["assets"]["nextPage"].as_u64().map(|value| value as u32));
        match next {
            Some(value) if value > page => page = value,
            _ => break,
        }
    }
    Ok(facts)
}

/// Immich's tags as they are, with the id and the whole name of each.
fn tag_list(settings: &ImmichSettings) -> Result<Vec<(String, String)>, String> {
    let tags = send(settings, "GET", "/api/tags", None)?;
    Ok(tags
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|tag| Some((tag["id"].as_str()?.to_string(), tag["value"].as_str()?.trim().trim_matches('/').to_string())))
        .filter(|(id, value)| !id.is_empty() && !value.is_empty())
        .collect())
}

/// Creates a tag, inside `parent` when one is given. Immich keeps the tree itself, through `parentId`.
#[tauri::command]
pub async fn immich_tag_create(store_id: String, parent: String, leaf: String) -> Result<String, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let leaf = leaf.trim().trim_matches('/').to_string();
        if leaf.is_empty() {
            return Err("Give the tag a name.".into());
        }
        let parent = parent.trim().trim_matches('/').to_string();
        let mut body = json!({ "name": leaf });
        if !parent.is_empty() {
            let tags = tag_list(&settings)?;
            let (id, _) = tags.iter().find(|(_, value)| value.eq_ignore_ascii_case(&parent)).ok_or("That tag no longer exists.")?;
            body["parentId"] = json!(checked_id(id)?);
        }
        let created = send(&settings, "POST", "/api/tags", Some(&body))?;
        Ok(created["value"].as_str().unwrap_or(&leaf).to_string())
    })
    .await
}

/// Renames a tag's last part. Immich carries the change into the tags below it.
#[tauri::command]
pub async fn immich_tag_rename(store_id: String, name: String, leaf: String) -> Result<String, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let leaf = leaf.trim().trim_matches('/').to_string();
        if leaf.is_empty() {
            return Err("Give the tag a name.".into());
        }
        let tags = tag_list(&settings)?;
        let (id, _) = tags.iter().find(|(_, value)| value.eq_ignore_ascii_case(name.trim())).ok_or("That tag no longer exists.")?;
        let renamed = send(&settings, "PUT", &format!("/api/tags/{}", checked_id(id)?), Some(&json!({ "name": leaf })))?;
        Ok(renamed["value"].as_str().map(str::to_string).unwrap_or_else(|| match name.rsplit_once('/') {
            Some((parent, _)) => format!("{parent}/{leaf}"),
            None => leaf.clone(),
        }))
    })
    .await
}

/// Deletes a tag and the tags below it. The pictures themselves stay where they are.
#[tauri::command]
pub async fn immich_tag_delete(store_id: String, name: String) -> Result<usize, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let name = name.trim().trim_matches('/').to_string();
        let mut branch: Vec<(String, String)> = tag_list(&settings)?.into_iter().filter(|(_, value)| inside(value, &name)).collect();
        if branch.is_empty() {
            return Err("That tag no longer exists.".into());
        }
        // Deepest first, so a tag never goes before the ones it holds.
        branch.sort_by_key(|(_, value)| std::cmp::Reverse(value.matches('/').count()));
        for (id, _) in &branch {
            send(&settings, "DELETE", &format!("/api/tags/{}", checked_id(id)?), None)?;
        }
        Ok(branch.len())
    })
    .await
}

/// Puts one tag on several of a store's pictures at once, or takes it off them. The tag is created
/// when it is new, with the tags above it for a name like `location/outside`.
#[tauri::command]
pub async fn immich_tag_paths(store_id: String, name: String, paths: Vec<String>, add: bool) -> Result<usize, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let name = name.trim().trim_matches('/').to_string();
        if name.is_empty() {
            return Err("Give the tag a name.".into());
        }
        let tags = send(&settings, "PUT", "/api/tags", Some(&json!({ "tags": [name] })))?;
        let tag_id = tags
            .as_array()
            .and_then(|tags| tags.iter().find(|tag| tag["value"].as_str() == Some(name.as_str())).or(tags.last()))
            .and_then(|tag| tag["id"].as_str())
            .ok_or("Immich did not create the tag.")?
            .to_string();
        let mut ids = Vec::new();
        let mut missing = None;
        for path in &paths {
            match asset_of(path) {
                Ok((_, id)) => ids.push(Value::String(id)),
                Err(error) => missing = Some(error),
            }
        }
        if ids.is_empty() {
            return Err(missing.unwrap_or_else(|| "These pictures are not in an Immich-compatible store.".into()));
        }
        let changed = ids.len();
        let method = if add { "PUT" } else { "DELETE" };
        bulk_result(&send(&settings, method, &format!("/api/tags/{}/assets", checked_id(&tag_id)?), Some(&json!({ "ids": ids })))?)?;
        if let Some(error) = missing {
            return Err(format!("{changed} of {} pictures: {error}", paths.len()));
        }
        Ok(changed)
    })
    .await
}

/// Immich's tags, which already carry their tree in `value` (`action/cooking`) and `parentId`.
#[tauri::command]
pub async fn immich_tags(store_id: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let mut names: Vec<String> = tag_list(&settings)?.into_iter().map(|(_, value)| value).collect();
        names.sort_by_key(|name| name.to_lowercase());
        names.dedup();
        Ok(names)
    })
    .await
}

/// Which tags each picture of the store carries, so the gallery can mark them and the tag tree can
/// count and open them. Immich has no call for this, so every tag's pictures are searched once; the
/// result is kept in `cache.db` until a refresh is asked for.
#[tauri::command]
pub async fn immich_tag_index(app: AppHandle, store_id: String, refresh: bool) -> Result<HashMap<String, Vec<String>>, String> {
    blocking(move || {
        // Without a refresh only what was already read is answered: building the index asks Immich for
        // every tag's pictures, which is the user's call to make, not something a store does on opening.
        if !refresh {
            return Ok(read_index(Index::Tags, &store_id).unwrap_or_default());
        }
        let (store, settings) = store_and_settings(&store_id)?;
        let tags = tag_list(&settings)?;
        let index = build_index(&settings, &store, &tags, tagged_originals, |done, total| {
            let _ = app.emit("tag-index", json!({ "id": store.id, "done": done, "total": total }));
        })?;
        write_index(Index::Tags, &store.id, &index);
        Ok(index)
    })
    .await
}

/// Which albums each picture of the store is in, for the gallery's album mark. Albums are few, so the
/// index is built the first time a store asks and kept in `cache.db`; `refresh` builds it again.
#[tauri::command]
pub async fn immich_album_index(store_id: String, refresh: bool) -> Result<HashMap<String, Vec<String>>, String> {
    blocking(move || {
        if !refresh {
            if let Some(index) = read_index(Index::Albums, &store_id) {
                return Ok(index);
            }
        }
        let (store, settings) = store_and_settings(&store_id)?;
        let albums = send(&settings, "GET", "/api/albums", None)?;
        let albums: Vec<(String, String)> = albums
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|album| Some((album["id"].as_str()?.to_string(), album["albumName"].as_str()?.trim().trim_matches('/').to_string())))
            .filter(|(id, name)| !id.is_empty() && !name.is_empty())
            .collect();
        let index = build_index(&settings, &store, &albums, album_originals, |_, _| {})?;
        write_index(Index::Albums, &store.id, &index);
        Ok(index)
    })
    .await
}

/// Searches each named entry's pictures a few at a time and gathers, for every store file, the names
/// it came up under.
fn build_index(
    settings: &ImmichSettings,
    store: &Store,
    entries: &[(String, String)],
    search: fn(&ImmichSettings, &str) -> Result<Vec<String>, String>,
    progress: impl Fn(usize, usize) + Sync,
) -> Result<HashMap<String, Vec<String>>, String> {
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let found: Mutex<HashMap<String, Vec<String>>> = Mutex::new(HashMap::new());
    let failure: Mutex<Option<String>> = Mutex::new(None);
    // A few at a time: one by one is minutes of waiting on a library this size.
    std::thread::scope(|scope| {
        for _ in 0..TAG_THREADS.min(entries.len().max(1)) {
            scope.spawn(|| loop {
                let Some((id, name)) = entries.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
                match search(settings, id) {
                    Ok(originals) => {
                        let mut found = found.lock().unwrap();
                        for original in originals {
                            if let Some(path) = store_path(store, &original) {
                                found.entry(path).or_default().push(name.clone());
                            }
                        }
                    }
                    Err(error) => *failure.lock().unwrap() = Some(error),
                }
                progress(done.fetch_add(1, Ordering::SeqCst) + 1, entries.len());
            });
        }
    });
    if let Some(error) = failure.into_inner().unwrap() {
        return Err(error);
    }
    let mut index = found.into_inner().unwrap();
    for names in index.values_mut() {
        names.sort_by_key(|name| name.to_lowercase());
        names.dedup();
    }
    Ok(index)
}

/// The originals carrying one tag, page by page.
fn tagged_originals(settings: &ImmichSettings, tag_id: &str) -> Result<Vec<String>, String> {
    let mut originals = Vec::new();
    let mut page = 1;
    while page <= MAX_SEARCH_PAGES {
        let body = json!({ "tagIds": [checked_id(tag_id)?], "size": SEARCH_PAGE, "page": page });
        let found = send(settings, "POST", "/api/search/metadata", Some(&body))?;
        let items = found["assets"]["items"].as_array().map(Vec::as_slice).unwrap_or_default();
        originals.extend(items.iter().filter_map(|asset| asset["originalPath"].as_str().map(str::to_string)));
        let next = found["assets"]["nextPage"].as_str().and_then(|value| value.parse::<u32>().ok()).or_else(|| found["assets"]["nextPage"].as_u64().map(|value| value as u32));
        match next {
            Some(value) if value > page => page = value,
            _ => break,
        }
    }
    Ok(originals)
}

#[derive(Clone, Copy)]
enum Index {
    Tags,
    Albums,
}

impl Index {
    /// The table of names by path and the table of when it was built.
    fn tables(self) -> (&'static str, &'static str) {
        match self {
            Index::Tags => ("store_tag_index", "store_tag_scans"),
            Index::Albums => ("store_album_index", "store_album_scans"),
        }
    }
}

/// When indexes started to hold pictures of external libraries; older ones are built again.
const INDEXES_READ_LIBRARIES_MS: i64 = 1789565811001;

fn read_index(kind: Index, store_id: &str) -> Option<HashMap<String, Vec<String>>> {
    let (names, scans) = kind.tables();
    let connection = super::db::cache_db();
    let scanned: Option<i64> = connection
        .query_row(&format!("SELECT scanned_ms FROM {scans} WHERE store_id = ?1"), [store_id], |row| row.get(0))
        .optional()
        .ok()
        .flatten();
    // Indexes built before pictures of external libraries were found hold none of them.
    if scanned? < INDEXES_READ_LIBRARIES_MS {
        return None;
    }
    let mut statement = connection.prepare(&format!("SELECT path, tags FROM {names} WHERE store_id = ?1")).ok()?;
    let rows = statement.query_map([store_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok()?;
    let mut index = HashMap::new();
    for row in rows.flatten() {
        index.insert(row.0, row.1.split('\n').map(str::to_string).filter(|name| !name.is_empty()).collect());
    }
    Some(index)
}

fn write_index(kind: Index, store_id: &str, index: &HashMap<String, Vec<String>>) {
    let (names, scans) = kind.tables();
    let mut connection = super::db::cache_db();
    let result = (|| -> rusqlite::Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute(&format!("DELETE FROM {names} WHERE store_id = ?1"), [store_id])?;
        {
            let mut insert = transaction.prepare_cached(&format!("INSERT OR REPLACE INTO {names} (store_id, path, tags) VALUES (?1, ?2, ?3)"))?;
            for (path, found) in index {
                insert.execute(rusqlite::params![store_id, path, found.join("\n")])?;
            }
        }
        transaction.execute(
            &format!("INSERT OR REPLACE INTO {scans} (store_id, scanned_ms) VALUES (?1, ?2)"),
            rusqlite::params![store_id, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64)],
        )?;
        transaction.commit()
    })();
    if let Err(error) = result {
        eprintln!("Cannot keep the index: {error}");
    }
}

/// An album Immich can be asked to change; a grouping album has nothing of its own to change.
fn real_album(album_id: &str) -> Result<&str, String> {
    if grouping_prefix(album_id).is_some() {
        return Err("This album only groups the albums below it. Choose one of those instead.".into());
    }
    checked_id(album_id)
}

/// The pictures of an Immich album as paths in the store folder, gathering every album below a grouping
/// album. Assets kept elsewhere are left out by the gallery, which only shows pictures it scanned.
#[tauri::command]
pub async fn immich_album_pictures(store_id: String, album_id: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let (store, settings) = store_and_settings(&store_id)?;
        let ids: Vec<String> = match grouping_prefix(&album_id) {
            Some(prefix) => {
                let albums = send(&settings, "GET", "/api/albums", None)?;
                albums
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter(|album| album["albumName"].as_str().is_some_and(|name| inside(name.trim().trim_matches('/'), prefix)))
                    .filter_map(|album| album["id"].as_str().map(str::to_string))
                    .collect()
            }
            None => vec![checked_id(&album_id)?.to_string()],
        };
        let mut paths = Vec::new();
        for id in ids {
            let originals = album_originals(&settings, checked_id(&id)?)?;
            paths.extend(originals.iter().filter_map(|original| store_path(&store, original)));
        }
        paths.sort();
        paths.dedup();
        Ok(paths)
    })
    .await
}

/// Where an album's cover asset lies in the store folder, for the sidebar's thumbnail.
#[tauri::command]
pub async fn immich_album_cover(store_id: String, asset_id: String) -> Result<Option<String>, String> {
    blocking(move || {
        let (store, settings) = store_and_settings(&store_id)?;
        let asset = send(&settings, "GET", &format!("/api/assets/{}", checked_id(&asset_id)?), None)?;
        Ok(asset["originalPath"].as_str().and_then(|original| store_path(&store, original)))
    })
    .await
}

#[tauri::command]
pub async fn immich_album_create(store_id: String, name: String) -> Result<Value, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Give the album a name.".into());
        }
        send(&settings, "POST", "/api/albums", Some(&json!({ "albumName": name })))
    })
    .await
}

#[tauri::command]
pub async fn immich_album_rename(store_id: String, album_id: String, name: String) -> Result<Value, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Give the album a name.".into());
        }
        send(&settings, "PATCH", &format!("/api/albums/{}", real_album(&album_id)?), Some(&json!({ "albumName": name })))
    })
    .await
}

/// Makes the picture at `path` the album's cover in Immich.
#[tauri::command]
pub async fn immich_album_set_cover(store_id: String, album_id: String, path: String) -> Result<Value, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let (_, asset_id) = asset_of(&path)?;
        send(&settings, "PATCH", &format!("/api/albums/{}", real_album(&album_id)?), Some(&json!({ "albumThumbnailAssetId": asset_id })))
    })
    .await
}

/// Deletes the album in Immich. Its pictures stay in Immich and on disk.
#[tauri::command]
pub async fn immich_album_delete(store_id: String, album_id: String) -> Result<(), String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        send(&settings, "DELETE", &format!("/api/albums/{}", real_album(&album_id)?), None)?;
        Ok(())
    })
    .await
}

/// Adds the pictures to an Immich album, or takes them out. Each path is looked up in Immich first, so
/// pictures Immich does not know are reported and the rest still go through.
#[tauri::command]
pub async fn immich_album_pictures_set(store_id: String, album_id: String, paths: Vec<String>, add: bool) -> Result<usize, String> {
    blocking(move || {
        let settings = store_and_settings(&store_id)?.1;
        let album_id = real_album(&album_id)?.to_string();
        let mut ids = Vec::new();
        let mut missing = Vec::new();
        for path in &paths {
            match asset_of(path) {
                Ok((_, id)) => ids.push(Value::String(id)),
                Err(error) => missing.push(error),
            }
        }
        if ids.is_empty() {
            return Err(missing.into_iter().next().unwrap_or_else(|| "These pictures are not in an Immich-compatible store.".into()));
        }
        let changed = ids.len();
        let method = if add { "PUT" } else { "DELETE" };
        bulk_result(&send(&settings, method, &format!("/api/albums/{album_id}/assets"), Some(&json!({ "ids": ids })))?)?;
        if let Some(error) = missing.into_iter().next() {
            return Err(format!("{changed} of {} pictures: {error}", paths.len()));
        }
        Ok(changed)
    })
    .await
}

/// The file on this computer an Immich original path points at: inside the store folder, or in one of
/// Immich's external libraries when that folder is mounted here too.
fn store_path(store: &Store, original: &str) -> Option<String> {
    upload_path(store, original).or_else(|| library_path(store, original))
}

/// The file in the store folder an Immich original path points at, when it lies inside the store.
fn upload_path(store: &Store, original: &str) -> Option<String> {
    let joined = |relative: &str| super::path_string(&Path::new(&store.path).join(relative));
    let immich_path = store.immich_path.trim_end_matches('/');
    if !immich_path.is_empty() {
        if let Some(relative) = original.strip_prefix(immich_path) {
            return Some(joined(relative.trim_start_matches('/')));
        }
    }
    // Immich's originals end in the same `ab/cd/name` the store is laid out by, so a path written
    // differently on the server (another mount, another upload folder) still points at the file here.
    let is_pair = |part: &str| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_hexdigit());
    let parts: Vec<&str> = original.rsplit('/').take(3).collect();
    match parts.as_slice() {
        [name, second, first] if is_pair(first) && is_pair(second) && name.to_ascii_lowercase().starts_with(&format!("{first}{second}").to_ascii_lowercase()) => {
            Some(joined(&format!("{first}/{second}/{name}")))
        }
        _ => None,
    }
}

/// Folders of external libraries found on this computer: the server's folder, the local one, and the
/// store whose Immich knows it. A miss is kept too, so a missing folder is looked for once.
static LIBRARY_FOLDERS: LazyLock<Mutex<HashMap<String, Option<(PathBuf, String)>>>> = LazyLock::new(Default::default);

/// A picture of an external library (Immich reads it from a folder of its own, such as `/mnt/photos`),
/// found at the same path here, where folder names may differ in case (`/mnt/Photos`).
fn library_path(store: &Store, original: &str) -> Option<String> {
    let original = Path::new(original);
    if !original.is_absolute() || super::picture_extension(original).is_none() {
        return None;
    }
    let folder = local_folder(original.parent()?, &store.id)?;
    Some(super::path_string(&folder.join(original.file_name()?)))
}

fn local_folder(server: &Path, store_id: &str) -> Option<PathBuf> {
    let key = server.to_string_lossy().into_owned();
    if let Some(known) = LIBRARY_FOLDERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&key) {
        return known.as_ref().map(|(local, _)| local.clone());
    }
    let local = match server.parent() {
        None => Some(server.to_path_buf()),
        Some(parent) => local_folder(parent, store_id).and_then(|parent_here| {
            let name = server.file_name()?;
            let exact = parent_here.join(name);
            if exact.is_dir() {
                return Some(exact);
            }
            let wanted = name.to_string_lossy().to_lowercase();
            let mut found = fs::read_dir(&parent_here)
                .ok()?
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().to_lowercase() == wanted && entry.path().is_dir());
            let first = found.next()?.path();
            // Two folders that differ only in case leave it unclear which one is meant.
            found.next().is_none().then_some(first)
        }),
    };
    LIBRARY_FOLDERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, local.clone().map(|local| (local, store_id.to_string())));
    local
}

/// The store and the server path of a picture found in an external library during this session.
fn library_original(path: &Path) -> Option<(String, String)> {
    let folders = LIBRARY_FOLDERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = path.parent()?;
    // The deepest folder, since `/` maps onto itself.
    folders
        .iter()
        .filter_map(|(server, found)| found.as_ref().map(|(local, store)| (server, local, store)))
        .filter(|(server, local, _)| local.as_path() == parent && server.as_str() != "/")
        .map(|(server, _, store)| (store.clone(), format!("{}/{}", server.trim_end_matches('/'), path.file_name().unwrap_or_default().to_string_lossy())))
        .next()
}

/// The Immich asset of a store picture, with the message to show when it has none.
fn asset_of(path: &str) -> Result<(ImmichSettings, String), String> {
    let file = PathBuf::from(path);
    let file = fs::canonicalize(&file).unwrap_or(file);
    find_asset(&file).ok_or_else(|| format!("{path} is not in an Immich-compatible store."))?
}

#[tauri::command]
pub fn immich_open(id: String, store_id: Option<String>) -> Result<(), String> {
    let settings = settings_of_store(store_id.as_deref())?;
    Command::new("xdg-open")
        .arg(format!("{}/photos/{}", settings.url, checked_id(&id)?))
        .spawn()
        .map_err(|error| format!("Cannot open Immich: {error}"))?;
    Ok(())
}

pub enum Upload {
    Created(String),
    /// Immich already had it; this is the asset it kept.
    Duplicate(String),
}

/// Uploads a picture as a new asset of the key's account. Immich skips pictures whose SHA-1 it has.
pub fn upload(store: &Store, data: &[u8], file_name: &str, sha1: &str, modified: SystemTime) -> Result<Upload, String> {
    let settings = store_settings(store).map_err(|_| "Add Immich's address and API key in Settings, or in this store, to save into it.".to_string())?;
    let date = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let device_asset = format!("inpaint-{sha1}");
    // The boundary holds the file's own hash, so the file cannot contain it.
    let boundary = format!("inpaint-boundary-{sha1}");
    let fields = [("deviceAssetId", device_asset.as_str()), ("deviceId", "inpaint"), ("fileCreatedAt", date.as_str()), ("fileModifiedAt", date.as_str())];
    let body = form_body(&boundary, &fields, ("assetData", file_name, data));
    let asset = call(&settings, "POST", "/api/assets", Payload::Form(boundary, body), UPLOAD_TIMEOUT, &[("x-immich-checksum", sha1)])?;
    let id = asset["id"].as_str().ok_or("Immich did not return the uploaded asset.")?;
    Ok(if asset["status"] == "duplicate" { Upload::Duplicate(id.to_string()) } else { Upload::Created(id.to_string()) })
}

/// Adds assets of a store to one of its Immich albums, as the drop box does after an upload.
pub fn add_to_album(store: &Store, album_id: &str, asset_ids: &[String]) -> Result<(), String> {
    if asset_ids.is_empty() {
        return Ok(());
    }
    let settings = store_settings(store)?;
    let ids: Vec<&str> = asset_ids.iter().map(|id| checked_id(id)).collect::<Result<_, _>>()?;
    bulk_result(&send(&settings, "PUT", &format!("/api/albums/{}/assets", real_album(album_id)?), Some(&json!({ "ids": ids })))?)
}

/// Where an asset's original is on this computer, when it lies in the store folder.
pub fn local_path(store: &Store, id: &str) -> Option<PathBuf> {
    let asset = request(&store_settings(store).ok()?, &format!("/api/assets/{id}"), None).ok()?;
    let original = asset["originalPath"].as_str()?;
    let relative = original.strip_prefix(store.immich_path.trim_end_matches('/'))?.trim_start_matches('/');
    Some(Path::new(&store.path).join(relative)).filter(|path| path.is_file())
}

/// The Immich asset of a picture in an Immich-compatible store, found through its original path.
/// None outside such stores.
fn find_asset(path: &Path) -> Option<Result<(ImmichSettings, String), String>> {
    let stores = super::stores::immich_stores();
    let (store, immich_path) = match stores.iter().find(|store| path.starts_with(&store.path)) {
        Some(store) => {
            let relative = path.strip_prefix(&store.path).ok()?.to_string_lossy().into_owned();
            (store.clone(), format!("{}/{relative}", store.immich_path))
        }
        None => {
            let (store_id, original) = library_original(path)?;
            (stores.into_iter().find(|store| store.id == store_id)?, original)
        }
    };
    let settings = match store_settings(&store) {
        Ok(settings) => settings,
        Err(_) => return Some(Err("add Immich's address and API key in Settings, or in this store".into())),
    };
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

    /// The user's own Immich settings, read straight from the database, since a test's own database is
    /// in memory. Only the ignored tests below use them.
    fn project_settings() -> ImmichSettings {
        let folder = std::env::var("INPAINT_PROJECT_DIR").expect("set INPAINT_PROJECT_DIR to the data directory");
        let connection = rusqlite::Connection::open(std::path::Path::new(&folder).join("inpaint.db")).expect("inpaint.db");
        let text: String = connection.query_row("SELECT value FROM settings WHERE key = 'immich'", [], |row| row.get(0)).expect("Immich settings");
        serde_json::from_str(&text).expect("Immich settings")
    }

    // Read-only calls to the configured Immich:
    // INPAINT_PROJECT_DIR=<checkout> cargo test --lib real_immich -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_immich_answers_through_the_agent() {
        let settings = project_settings();
        let version = send(&settings, "GET", "/api/server/version", None).unwrap();
        println!("Immich {}.{}.{}", version["major"], version["minor"], version["patch"]);
        assert!(send(&settings, "GET", "/api/users/me", None).unwrap()["id"].is_string());
        println!("{} tags", send(&settings, "GET", "/api/tags", None).unwrap().as_array().map_or(0, Vec::len));
        let refused = send(&settings, "GET", "/api/assets/00000000-0000-0000-0000-000000000000", None).unwrap_err();
        println!("{refused}");
        assert!(refused.starts_with("Immich answered 4"), "{refused}");
    }

    #[test]
    fn album_names_with_slashes_read_as_a_tree() {
        let albums = vec![
            json!({ "id": "a1", "albumName": "Trips/2024/Rome", "assetCount": 3, "albumThumbnailAssetId": "c1" }),
            json!({ "id": "a2", "albumName": "Trips", "assetCount": 1 }),
            json!({ "id": "a3", "albumName": "Family", "assetCount": 2 }),
        ];
        let tree = album_tree("s", &albums);
        let album = |full: &str| tree.iter().find(|album| album.full_name == full).expect(full).clone();
        assert_eq!(tree.len(), 4, "the part 2024 becomes an album of its own");
        let grouping = album("Trips/2024");
        assert!(grouping.is_virtual);
        assert_eq!((grouping.name.as_str(), grouping.count, grouping.total), ("2024", 0, 3));
        assert_eq!(grouping.parent_id, "a2", "a real album holds it");
        assert_eq!(grouping.cover_asset_id, "c1", "a grouping album shows a cover from below it");
        let trips = album("Trips");
        assert_eq!((trips.count, trips.total, trips.parent_id.as_str(), trips.is_virtual), (1, 4, "", false));
        assert_eq!(album("Trips/2024/Rome").parent_id, "path:Trips/2024");
        assert_eq!((album("Family").total, album("Family").parent_id.as_str()), (2, ""));
        assert!(real_album("path:Trips").is_err() && grouping_prefix("path:Trips") == Some("Trips"));
    }

    #[test]
    fn originals_map_into_the_store_folder() {
        let store = Store { path: "/pics".into(), immich_path: "/data/upload/u1/".into(), ..Default::default() };
        assert_eq!(store_path(&store, "/data/upload/u1/ab/cd/abcd.jpg").unwrap(), "/pics/ab/cd/abcd.jpg");
        // A server that writes its originals under another folder still lands on the same file.
        assert_eq!(store_path(&store, "/usr/src/app/upload/upload/u1/ab/cd/abcd.jpg").unwrap(), "/pics/ab/cd/abcd.jpg");
        assert_eq!(store_path(&store, "abcd.jpg"), None);
        // Only the upload layout is read that way; a library folder is not taken for one.
        assert_eq!(upload_path(&store, "/mnt/photos/Trips/2023/IMG_1.jpg"), None);
    }

    #[test]
    fn library_pictures_are_found_in_folders_named_in_another_case() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("Photos/Family");
        fs::create_dir_all(&local).unwrap();
        let store = Store { id: "s1".into(), path: "/pics".into(), ..Default::default() };
        let server = format!("{}/photos/family/IMG_1.jpg", root.path().display());
        let found = store_path(&store, &server).unwrap();
        assert_eq!(found, super::super::path_string(&local.join("IMG_1.jpg")));
        assert_eq!(library_original(Path::new(&found)), Some(("s1".into(), server.clone())));
        // Videos and folders missing here are left out.
        assert_eq!(store_path(&store, &server.replace(".jpg", ".mp4")), None);
        assert_eq!(store_path(&store, &format!("{}/elsewhere/IMG_1.jpg", root.path().display())), None);
    }

    // INPAINT_PROJECT_DIR=<checkout> cargo test --lib real_immich_albums -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_immich_albums() {
        let settings = project_settings();
        let folder = std::env::var("INPAINT_PROJECT_DIR").unwrap();
        let connection = rusqlite::Connection::open(std::path::Path::new(&folder).join("inpaint.db")).unwrap();
        let store: Store = connection
            .query_row("SELECT name, path, immich_path FROM stores WHERE immich = 1 LIMIT 1", [], |row| {
                Ok(Store { name: row.get(0)?, path: row.get(1)?, immich_path: row.get(2)?, immich: true, ..Default::default() })
            })
            .expect("an Immich-compatible store");
        println!("store {} at {} (Immich path {})", store.name, store.path, store.immich_path);
        let listed = send(&settings, "GET", "/api/albums", None).unwrap();
        let listed = listed.as_array().cloned().unwrap_or_default();
        println!("{} albums", listed.len());
        for album in listed.iter().take(5) {
            println!("  {} ({} assets) id {}", album["albumName"], album["assetCount"], album["id"]);
        }
        let tree = album_tree(&store.id, &listed);
        for album in tree.iter().take(8) {
            println!("  tree {} parent {:?} count {} total {} virtual {}", album.full_name, album.parent_id, album.count, album.total, album.is_virtual);
        }
        let Some(biggest) = listed.iter().max_by_key(|album| album["assetCount"].as_u64().unwrap_or(0)) else { return };
        let id = biggest["id"].as_str().unwrap();
        let originals = album_originals(&settings, id).unwrap();
        println!("album {} counts {} and search found {}", biggest["albumName"], biggest["assetCount"], originals.len());
        let mapped = originals.iter().filter_map(|original| store_path(&store, original)).filter(|path| std::path::Path::new(path).is_file()).count();
        println!("  {mapped} of them are files in this store");
        if let Some(original) = originals.first() {
            println!("  first {original} -> {:?}", store_path(&store, original));
        }
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
