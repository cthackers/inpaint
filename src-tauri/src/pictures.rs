//! What Inpaint knows about a picture of its own: the favourite mark, rating, description, tags and
//! people kept in `inpaint.db`, plus the facts read from the file itself.
//!
//! Pictures of Immich-compatible stores keep this in Immich instead (`immich.rs`); everything else,
//! inside a store or not, is recorded here and addressed by its path.

use super::{albums, db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// A tag or a person, which are the same thing with a different kind.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Label {
    pub id: String,
    /// `tag` or `person`.
    pub kind: String,
    pub name: String,
    /// How many pictures carry it, for the picker's hint.
    pub count: u64,
}

/// What the file itself says, for the details of the Info panel.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Details {
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub modified_ms: u128,
    pub width: u32,
    pub height: u32,
    /// Camera and capture details, when the file carries EXIF.
    pub taken: String,
    pub make: String,
    pub model: String,
    pub lens: String,
    pub exposure: String,
    pub aperture: String,
    pub iso: String,
    pub focal_length: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureInfo {
    path: String,
    favorite: bool,
    rating: i64,
    description: String,
    tags: Vec<Label>,
    people: Vec<Label>,
    /// The albums of the store holding the picture that have it.
    albums: Vec<albums::Album>,
    /// The store the picture belongs to, empty outside stores, where it can be in no album.
    store_id: String,
    details: Details,
}

fn database_error(error: rusqlite::Error) -> String {
    format!("Cannot use the picture's details: {error}")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis())
}

fn checked_kind(kind: &str) -> Result<&str, String> {
    match kind {
        "tag" | "person" => Ok(kind),
        _ => Err(format!("{kind} is neither a tag nor a person.")),
    }
}

const LABEL_COLUMNS: &str = "labels.id, labels.kind, labels.name, (SELECT COUNT(*) FROM picture_labels WHERE label_id = labels.id)";

fn read_label(row: &rusqlite::Row) -> rusqlite::Result<Label> {
    Ok(Label { id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?, count: row.get::<_, i64>(3)? as u64 })
}

/// Every tag and person, for the pickers.
#[tauri::command]
pub fn labels_all() -> Result<Vec<Label>, String> {
    let connection = db::settings_db();
    let mut statement = connection.prepare(&format!("SELECT {LABEL_COLUMNS} FROM labels ORDER BY labels.name COLLATE NOCASE")).map_err(database_error)?;
    let labels = statement.query_map([], read_label).map_err(database_error)?;
    labels.collect::<rusqlite::Result<_>>().map_err(database_error)
}

/// Creates a tag or a person, or returns the one already carrying that name.
#[tauri::command]
pub fn label_create(kind: String, name: String) -> Result<Label, String> {
    let kind = checked_kind(&kind)?;
    let name = name.trim().trim_matches('/').to_string();
    if name.is_empty() {
        return Err("Give it a name.".into());
    }
    let name: String = name.chars().take(120).collect();
    let connection = db::settings_db();
    let existing: Option<String> = connection
        .query_row("SELECT id FROM labels WHERE kind = ?1 AND name = ?2 COLLATE NOCASE", params![kind, name], |row| row.get(0))
        .optional()
        .map_err(database_error)?;
    let id = match existing {
        Some(id) => id,
        None => {
            let id = super::stores::new_id();
            connection.execute("INSERT INTO labels (id, kind, name) VALUES (?1, ?2, ?3)", params![id, kind, name]).map_err(database_error)?;
            id
        }
    };
    connection
        .query_row(&format!("SELECT {LABEL_COLUMNS} FROM labels WHERE id = ?1"), [&id], read_label)
        .map_err(database_error)
}

/// Adds a tag or a person to a picture, or takes it off.
#[tauri::command]
pub fn picture_label(path: String, label_id: String, add: bool) -> Result<(), String> {
    let connection = db::settings_db();
    if add {
        connection
            .execute("INSERT OR IGNORE INTO picture_labels (path, label_id) VALUES (?1, ?2)", params![path, label_id])
            .map_err(database_error)?;
    } else {
        connection.execute("DELETE FROM picture_labels WHERE path = ?1 AND label_id = ?2", params![path, label_id]).map_err(database_error)?;
    }
    Ok(())
}

/// Puts one tag on several pictures at once, or takes it off them, creating the tag when it is new.
#[tauri::command]
pub fn pictures_tag(paths: Vec<String>, name: String, add: bool) -> Result<Label, String> {
    let label = label_create("tag".into(), name)?;
    let mut connection = db::settings_db();
    let transaction = connection.transaction().map_err(database_error)?;
    {
        let statement = if add { "INSERT OR IGNORE INTO picture_labels (path, label_id) VALUES (?1, ?2)" } else { "DELETE FROM picture_labels WHERE path = ?1 AND label_id = ?2" };
        let mut statement = transaction.prepare(statement).map_err(database_error)?;
        for path in &paths {
            statement.execute(params![path, label.id]).map_err(database_error)?;
        }
    }
    transaction.commit().map_err(database_error)?;
    Ok(label)
}

/// The whole name a tag gets when its last part is renamed: `location/inside` for `location/outside`.
fn renamed(full: &str, leaf: &str) -> Result<String, String> {
    let leaf = leaf.trim().trim_matches('/');
    if leaf.is_empty() {
        return Err("Give the tag a name.".into());
    }
    Ok(match full.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{leaf}"),
        None => leaf.to_string(),
    })
}

/// Renames a tag and the tags below it, whose names carry it.
#[tauri::command]
pub fn tag_rename(name: String, leaf: String) -> Result<String, String> {
    let full = renamed(&name, &leaf)?;
    let connection = db::settings_db();
    connection
        .execute(
            "UPDATE labels SET name = ?1 || substr(name, ?2) WHERE kind = 'tag' AND (name = ?3 OR name LIKE ?3 || '/%')",
            params![full, name.chars().count() as i64 + 1, name],
        )
        .map_err(database_error)?;
    Ok(full)
}

/// Removes a tag and the tags below it from every picture.
#[tauri::command]
pub fn tag_delete(name: String) -> Result<(), String> {
    let mut connection = db::settings_db();
    let transaction = connection.transaction().map_err(database_error)?;
    let branch = "SELECT id FROM labels WHERE kind = 'tag' AND (name = ?1 OR name LIKE ?1 || '/%')";
    transaction.execute(&format!("DELETE FROM picture_labels WHERE label_id IN ({branch})"), [&name]).map_err(database_error)?;
    transaction.execute(&format!("DELETE FROM labels WHERE id IN ({branch})"), [&name]).map_err(database_error)?;
    transaction.commit().map_err(database_error)?;
    Ok(())
}

/// Removes a tag or a person everywhere, for when it was created by mistake.
#[tauri::command]
pub fn label_delete(label_id: String) -> Result<(), String> {
    let connection = db::settings_db();
    connection.execute("DELETE FROM picture_labels WHERE label_id = ?1", [&label_id]).map_err(database_error)?;
    connection.execute("DELETE FROM labels WHERE id = ?1", [&label_id]).map_err(database_error)?;
    Ok(())
}

/// Saves the favourite mark, the rating or the description; only the fields given change.
#[tauri::command]
pub fn picture_update(path: String, favorite: Option<bool>, rating: Option<i64>, description: Option<String>) -> Result<(), String> {
    if rating.is_some_and(|rating| !(0..=5).contains(&rating)) {
        return Err("A rating goes from 0 to 5.".into());
    }
    let description = description.map(|text| text.chars().take(4000).collect::<String>());
    let connection = db::settings_db();
    connection
        .execute("INSERT OR IGNORE INTO picture_meta (path, updated_ms) VALUES (?1, ?2)", params![path, now_ms() as i64])
        .map_err(database_error)?;
    connection
        .execute(
            "UPDATE picture_meta SET
                favorite = COALESCE(?2, favorite),
                rating = COALESCE(?3, rating),
                description = COALESCE(?4, description),
                updated_ms = ?5
             WHERE path = ?1",
            params![path, favorite, rating, description, now_ms() as i64],
        )
        .map_err(database_error)?;
    Ok(())
}

fn labels_of(connection: &Connection, path: &str, kind: &str) -> rusqlite::Result<Vec<Label>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {LABEL_COLUMNS} FROM labels JOIN picture_labels ON picture_labels.label_id = labels.id
         WHERE picture_labels.path = ?1 AND labels.kind = ?2 ORDER BY labels.name COLLATE NOCASE"
    ))?;
    let labels = statement.query_map(params![path, kind], read_label)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(labels)
}

/// Everything the Info panel shows for a picture that is not Immich's.
#[tauri::command]
pub fn picture_info(path: String) -> Result<PictureInfo, String> {
    // These take the settings database themselves, so they run before this one holds it.
    let store = super::stores::all_stores().into_iter().find(|store| Path::new(&path).starts_with(&store.path));
    let holding = albums::albums_of_picture(path.clone())?;
    let connection = db::settings_db();
    let meta: Option<(bool, i64, String)> = connection
        .query_row("SELECT favorite, rating, description FROM picture_meta WHERE path = ?1", [&path], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()
        .map_err(database_error)?;
    let (favorite, rating, description) = meta.unwrap_or((false, 0, String::new()));
    // Only the albums that hold the picture itself; a parent shows it through them.
    let albums = match &store {
        Some(store) => albums::list(&connection, &store.id).map_err(database_error)?.into_iter().filter(|album| holding.contains(&album.id)).collect(),
        None => Vec::new(),
    };
    Ok(PictureInfo {
        favorite,
        rating,
        description,
        tags: labels_of(&connection, &path, "tag").map_err(database_error)?,
        people: labels_of(&connection, &path, "person").map_err(database_error)?,
        albums,
        store_id: store.map(|store| store.id).unwrap_or_default(),
        details: details_of(Path::new(&path)),
        path,
    })
}

/// The tags of every picture of a store that carries any, for the gallery's marks and its tag tree.
#[tauri::command]
pub fn store_tags(store_id: String) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let store = super::stores::find_store(&store_id)?;
    let prefix = format!("{}/", store.path.trim_end_matches('/'));
    let connection = db::settings_db();
    let mut statement = connection
        .prepare(
            "SELECT picture_labels.path, labels.name FROM picture_labels
             JOIN labels ON labels.id = picture_labels.label_id
             WHERE labels.kind = 'tag' AND picture_labels.path LIKE ?1 ESCAPE '\\'
             ORDER BY labels.name COLLATE NOCASE",
        )
        .map_err(database_error)?;
    // A path is matched by its store folder; the characters LIKE treats specially are escaped.
    let pattern = format!("{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows = statement.query_map([pattern], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(database_error)?;
    let mut tags: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for row in rows {
        let (path, name) = row.map_err(database_error)?;
        tags.entry(path).or_default().push(name);
    }
    Ok(tags)
}

/// What the gallery sorts and filters by, beyond the file itself.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub favorite: bool,
    /// 0 to 5 stars.
    pub rating: u8,
    /// When Immich received the picture; the file's own creation time counts where this is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_ms: Option<i64>,
}

/// Favourites and ratings of a store's pictures, or of a folder's. Pictures of an Immich-compatible
/// store come from Immich, read in full when `refresh` asks or nothing was read before, and kept in
/// cache.db between readings; the others list only pictures that are favourites or rated.
#[tauri::command]
pub async fn picture_facts(store_id: Option<String>, folder: Option<String>, refresh: bool) -> Result<std::collections::HashMap<String, Facts>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = store_id.as_deref().map(super::stores::find_store).transpose()?;
        if let Some(store) = store.as_ref().filter(|store| store.immich) {
            if !refresh {
                if let Some(cached) = read_facts(&store.id) {
                    return Ok(cached);
                }
            }
            let facts = super::immich::asset_facts(store)?;
            write_facts(&store.id, &facts);
            return Ok(facts);
        }
        let Some(folder) = store.map(|store| store.path).or(folder) else { return Ok(Default::default()) };
        let prefix = format!("{}/", folder.trim_end_matches('/'));
        let pattern = format!("{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let connection = db::settings_db();
        let mut statement = connection
            .prepare("SELECT path, favorite, rating FROM picture_meta WHERE (favorite <> 0 OR rating <> 0) AND path LIKE ?1 ESCAPE '\\'")
            .map_err(database_error)?;
        let rows = statement
            .query_map([pattern], |row| Ok((row.get::<_, String>(0)?, Facts { favorite: row.get::<_, i64>(1)? != 0, rating: row.get::<_, i64>(2)?.clamp(0, 5) as u8, added_ms: None })))
            .map_err(database_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(database_error)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn read_facts(store_id: &str) -> Option<std::collections::HashMap<String, Facts>> {
    let connection = db::cache_db();
    let mut statement = connection.prepare("SELECT path, favorite, rating, added_ms FROM store_facts WHERE store_id = ?1").ok()?;
    let facts: std::collections::HashMap<String, Facts> = statement
        .query_map([store_id], |row| {
            Ok((row.get::<_, String>(0)?, Facts { favorite: row.get::<_, i64>(1)? != 0, rating: row.get::<_, i64>(2)? as u8, added_ms: Some(row.get(3)?).filter(|added: &i64| *added > 0) }))
        })
        .ok()?
        .collect::<rusqlite::Result<_>>()
        .ok()?;
    (!facts.is_empty()).then_some(facts)
}

fn write_facts(store_id: &str, facts: &std::collections::HashMap<String, Facts>) {
    let mut connection = db::cache_db();
    let result = (|| -> rusqlite::Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM store_facts WHERE store_id = ?1", [store_id])?;
        {
            let mut insert = transaction.prepare_cached("INSERT OR REPLACE INTO store_facts (store_id, path, favorite, rating, added_ms) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for (path, fact) in facts {
                insert.execute(params![store_id, path, fact.favorite, fact.rating, fact.added_ms.unwrap_or(0)])?;
            }
        }
        transaction.commit()
    })();
    if let Err(error) = result {
        eprintln!("Cannot keep the picture facts: {error}");
    }
}

/// A note on part of a picture: a box, as fractions of the picture's width and height so it stays in
/// place when the picture is resized, and the text written in it.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Annotation {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub created_ms: u128,
}

fn read_annotation(row: &rusqlite::Row) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        x: row.get(1)?,
        y: row.get(2)?,
        width: row.get(3)?,
        height: row.get(4)?,
        text: row.get(5)?,
        created_ms: row.get::<_, i64>(6)? as u128,
    })
}

/// The box must lie inside the picture and cover some of it.
fn checked_box(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let inside = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
    if ![x, y, width, height].into_iter().all(inside) || width <= 0.0 || height <= 0.0 || x + width > 1.000_001 || y + height > 1.000_001 {
        return Err("An annotation must lie inside the picture.".into());
    }
    Ok(())
}

fn checked_text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write something in the annotation.".into());
    }
    Ok(text.chars().take(2000).collect())
}

/// A picture's annotations, oldest first.
#[tauri::command]
pub fn annotations_list(path: String) -> Result<Vec<Annotation>, String> {
    let connection = db::settings_db();
    let mut statement = connection
        .prepare("SELECT id, x, y, width, height, text, created_ms FROM annotations WHERE path = ?1 ORDER BY created_ms, id")
        .map_err(database_error)?;
    let annotations = statement.query_map([&path], read_annotation).map_err(database_error)?;
    annotations.collect::<rusqlite::Result<_>>().map_err(database_error)
}

#[tauri::command]
pub fn annotation_create(path: String, x: f64, y: f64, width: f64, height: f64, text: String) -> Result<Annotation, String> {
    checked_box(x, y, width, height)?;
    let annotation = Annotation { id: super::stores::new_id(), x, y, width, height, text: checked_text(&text)?, created_ms: now_ms() };
    db::settings_db()
        .execute(
            "INSERT INTO annotations (id, path, x, y, width, height, text, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![annotation.id, path, x, y, width, height, annotation.text, annotation.created_ms as i64],
        )
        .map_err(database_error)?;
    Ok(annotation)
}

#[tauri::command]
pub fn annotation_update(id: String, text: String) -> Result<(), String> {
    let changed = db::settings_db().execute("UPDATE annotations SET text = ?1 WHERE id = ?2", params![checked_text(&text)?, id]).map_err(database_error)?;
    if changed == 0 {
        return Err("This annotation no longer exists.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn annotation_delete(id: String) -> Result<(), String> {
    db::settings_db().execute("DELETE FROM annotations WHERE id = ?1", [&id]).map_err(database_error)?;
    Ok(())
}

/// Drops everything kept about a picture that is gone.
pub fn forget_picture(path: &str) {
    let connection = db::settings_db();
    for statement in ["DELETE FROM picture_labels WHERE path = ?1", "DELETE FROM picture_meta WHERE path = ?1", "DELETE FROM annotations WHERE path = ?1"] {
        if let Err(error) = connection.execute(statement, [path]) {
            eprintln!("Cannot update the picture's details: {error}");
        }
    }
}

fn details_of(path: &Path) -> Details {
    let mut details = Details {
        name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        extension: super::picture_extension(path).unwrap_or_default(),
        ..Default::default()
    };
    if let Ok(metadata) = fs::metadata(path) {
        details.size = metadata.len();
        details.modified_ms = super::stores::modified_ms(&metadata);
    }
    if let Ok((width, height)) = image::image_dimensions(path) {
        (details.width, details.height) = (width, height);
    }
    read_exif(path, &mut details);
    details
}

/// Fills in what the file's EXIF says, leaving the fields empty when it has none.
fn read_exif(path: &Path, details: &mut Details) {
    let Ok(file) = fs::File::open(path) else { return };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else { return };
    let value = |tag: exif::Tag| {
        exif.get_field(tag, exif::In::PRIMARY)
            .map(|field| field.display_value().with_unit(&exif).to_string())
            .unwrap_or_default()
    };
    details.taken = match value(exif::Tag::DateTimeOriginal) {
        taken if taken.is_empty() => value(exif::Tag::DateTime),
        taken => taken,
    };
    details.make = value(exif::Tag::Make).trim_matches('"').to_string();
    details.model = value(exif::Tag::Model).trim_matches('"').to_string();
    details.lens = value(exif::Tag::LensModel).trim_matches('"').to_string();
    details.exposure = value(exif::Tag::ExposureTime);
    details.aperture = value(exif::Tag::FNumber);
    details.iso = value(exif::Tag::PhotographicSensitivity);
    details.focal_length = value(exif::Tag::FocalLength);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(db::SETTINGS_SCHEMA).unwrap();
        connection
    }

    #[test]
    fn labels_are_kept_once_per_name_and_counted() {
        let connection = prepared();
        connection.execute("INSERT INTO labels (id, kind, name) VALUES ('t1', 'tag', 'Trips')", []).unwrap();
        connection.execute("INSERT INTO labels (id, kind, name) VALUES ('p1', 'person', 'Ada')", []).unwrap();
        connection.execute("INSERT INTO picture_labels (path, label_id) VALUES ('/a.jpg', 't1'), ('/b.jpg', 't1'), ('/a.jpg', 'p1')", []).unwrap();
        let tags = labels_of(&connection, "/a.jpg", "tag").unwrap();
        assert_eq!((tags.len(), tags[0].name.as_str(), tags[0].count), (1, "Trips", 2));
        let people = labels_of(&connection, "/a.jpg", "person").unwrap();
        assert_eq!((people.len(), people[0].name.as_str()), (1, "Ada"));
        assert!(labels_of(&connection, "/b.jpg", "person").unwrap().is_empty());
        assert!(checked_kind("tag").is_ok() && checked_kind("album").is_err());
    }

    #[test]
    fn a_picture_reads_back_what_was_saved_about_it() {
        let path = "/tmp/inpaint-test-picture.jpg".to_string();
        picture_update(path.clone(), Some(true), Some(4), Some("A test".into())).unwrap();
        let tag = label_create("tag".into(), "Trips".into()).unwrap();
        // The same name gives the same tag back rather than a second one.
        assert_eq!(label_create("tag".into(), " trips ".into()).unwrap().id, tag.id);
        picture_label(path.clone(), tag.id.clone(), true).unwrap();
        let info = picture_info(path.clone()).unwrap();
        assert_eq!((info.favorite, info.rating, info.description.as_str()), (true, 4, "A test"));
        assert_eq!(info.tags.iter().map(|label| label.name.as_str()).collect::<Vec<_>>(), ["Trips"]);
        assert!(info.people.is_empty() && info.albums.is_empty() && info.store_id.is_empty());
        // Only the fields given change.
        picture_update(path.clone(), None, Some(2), None).unwrap();
        let info = picture_info(path.clone()).unwrap();
        assert_eq!((info.favorite, info.rating, info.description.as_str()), (true, 2, "A test"));
        picture_label(path.clone(), tag.id.clone(), false).unwrap();
        assert!(picture_info(path.clone()).unwrap().tags.is_empty());
        assert!(picture_update(path.clone(), None, Some(9), None).is_err());
        forget_picture(&path);
        assert_eq!(picture_info(path).unwrap().rating, 0);
        label_delete(tag.id.clone()).unwrap();
        assert!(!labels_all().unwrap().iter().any(|label| label.id == tag.id));
    }

    #[test]
    fn renaming_a_tag_carries_the_tags_below_it() {
        assert_eq!(renamed("location/outside", " inside ").unwrap(), "location/inside");
        assert_eq!(renamed("location", "place").unwrap(), "place");
        assert!(renamed("location", " / ").is_err());
        // The tests share one database, so these names are theirs alone.
        let path = "/tmp/inpaint-test-tags.jpg".to_string();
        for name in ["where", "where/outside", "where/outside/roof", "wheres"] {
            let label = label_create("tag".into(), name.into()).unwrap();
            picture_label(path.clone(), label.id, true).unwrap();
        }
        let names = || {
            let mut names: Vec<String> = labels_all().unwrap().into_iter().map(|label| label.name).filter(|name| name.starts_with("where")).collect();
            names.sort();
            names
        };
        tag_rename("where/outside".into(), "inside".into()).unwrap();
        assert_eq!(names(), ["where", "where/inside", "where/inside/roof", "wheres"]);
        tag_delete("where/inside".into()).unwrap();
        assert_eq!(names(), ["where", "wheres"], "the branch goes, its neighbour stays");
        assert_eq!(picture_info(path.clone()).unwrap().tags.len(), 2);
        tag_delete("where".into()).unwrap();
        tag_delete("wheres".into()).unwrap();
        assert!(names().is_empty());
        forget_picture(&path);
    }

    #[test]
    fn annotations_keep_their_box_and_text() {
        let path = "/tmp/inpaint-test-annotations.jpg".to_string();
        let first = annotation_create(path.clone(), 0.1, 0.2, 0.3, 0.4, "  A crack in the wall  ".into()).unwrap();
        let second = annotation_create(path.clone(), 0.5, 0.5, 0.5, 0.5, "Sky".into()).unwrap();
        let listed = annotations_list(path.clone()).unwrap();
        assert_eq!(listed.iter().map(|note| note.text.as_str()).collect::<Vec<_>>(), ["A crack in the wall", "Sky"]);
        assert_eq!((listed[0].x, listed[0].y, listed[0].width, listed[0].height), (0.1, 0.2, 0.3, 0.4));
        annotation_update(first.id.clone(), "A long crack".into()).unwrap();
        assert_eq!(annotations_list(path.clone()).unwrap()[0].text, "A long crack");
        // Boxes outside the picture, empty boxes and empty text are refused.
        assert!(annotation_create(path.clone(), 0.8, 0.0, 0.3, 0.1, "Off the edge".into()).is_err());
        assert!(annotation_create(path.clone(), 0.1, 0.1, 0.0, 0.1, "Flat".into()).is_err());
        assert!(annotation_create(path.clone(), 0.1, 0.1, 0.1, 0.1, "   ".into()).is_err());
        annotation_delete(second.id).unwrap();
        assert_eq!(annotations_list(path.clone()).unwrap().len(), 1);
        forget_picture(&path);
        assert!(annotations_list(path).unwrap().is_empty());
    }

    #[test]
    fn details_read_the_file_itself() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("photo.jpg");
        image::RgbImage::new(7, 3).save(&path).unwrap();
        let details = details_of(&path);
        assert_eq!((details.name.as_str(), details.extension.as_str(), details.width, details.height), ("photo.jpg", "jpg", 7, 3));
        assert!(details.size > 0 && details.modified_ms > 0);
        // A picture without EXIF simply has nothing to show.
        assert_eq!(details.make, "");
        assert_eq!(details_of(Path::new("/nothing/here.jpg")).width, 0);
    }
}
