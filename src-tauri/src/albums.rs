//! Albums of an image store: named sets of its pictures, kept in the `albums` and `album_pictures`
//! tables of `inpaint.db`.
//!
//! An album can hold other albums, and a parent counts and shows the pictures of everything below it,
//! so albums read like folders even though a picture may sit in several of them. A picture is only a
//! path inside the store folder; nothing is moved or copied. Stores marked Immich compatible use
//! Immich's own albums instead (`immich.rs`), which is why an album carries the store it belongs to.

use super::{db, stores};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// One album of a store, with the picture counts the sidebar shows. Immich albums (`immich.rs`) are
/// described the same way, with no parent and `cover_asset_id` instead of a cover path.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Album {
    pub id: String,
    pub store_id: String,
    /// The album holding this one, empty at the top level. Always empty for Immich albums.
    pub parent_id: String,
    pub name: String,
    /// The whole name, which for Immich albums holds the path the tree was read from (`Trips/Rome`).
    pub full_name: String,
    /// True for an Immich album that only groups others: a part of a name, with no album of its own.
    pub is_virtual: bool,
    /// The picture shown for the album: the chosen cover, or the newest picture below it.
    pub cover_path: String,
    /// Immich's cover asset, which the frontend resolves to a file with `immich_album_cover`.
    pub cover_asset_id: String,
    /// Pictures added to this album itself.
    pub count: u64,
    /// Pictures in this album and every album below it, counting each one once.
    pub total: u64,
    pub created_ms: u128,
}

fn database_error(error: rusqlite::Error) -> String {
    format!("Cannot use the albums: {error}")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis())
}

/// The albums below `?1`, itself included, for counting and for deleting a whole branch.
const BRANCH: &str = "WITH RECURSIVE branch(id) AS (
    SELECT ?1 UNION SELECT albums.id FROM albums JOIN branch ON albums.parent_id = branch.id
)";

const LIST_ALBUMS: &str = "WITH RECURSIVE below(root, id) AS (
    SELECT id, id FROM albums WHERE store_id = ?1
    UNION
    SELECT below.root, albums.id FROM albums JOIN below ON albums.parent_id = below.id
)
SELECT
    album.id,
    album.parent_id,
    album.name,
    CASE
        WHEN album.cover_path <> '' THEN album.cover_path
        ELSE COALESCE((SELECT picture.path FROM below JOIN album_pictures picture ON picture.album_id = below.id
                       WHERE below.root = album.id ORDER BY picture.added_ms DESC, picture.path LIMIT 1), '')
    END,
    album.created_ms,
    (SELECT COUNT(*) FROM album_pictures WHERE album_id = album.id),
    (SELECT COUNT(DISTINCT picture.path) FROM below JOIN album_pictures picture ON picture.album_id = below.id WHERE below.root = album.id)
FROM albums album
WHERE album.store_id = ?1
ORDER BY album.name COLLATE NOCASE, album.id";

/// Every album of a store, parents before children left to the frontend to nest.
pub(crate) fn list(connection: &Connection, store_id: &str) -> rusqlite::Result<Vec<Album>> {
    let mut statement = connection.prepare(LIST_ALBUMS)?;
    let albums = statement.query_map([store_id], |row| {
        Ok(Album {
            id: row.get(0)?,
            store_id: store_id.to_string(),
            parent_id: row.get(1)?,
            name: row.get(2)?,
            full_name: row.get(2)?,
            is_virtual: false,
            cover_path: row.get(3)?,
            cover_asset_id: String::new(),
            created_ms: row.get::<_, i64>(4)? as u128,
            count: row.get::<_, i64>(5)? as u64,
            total: row.get::<_, i64>(6)? as u64,
        })
    })?;
    albums.collect()
}

#[tauri::command]
pub fn albums_list(store_id: String) -> Result<Vec<Album>, String> {
    list(&db::settings_db(), &store_id).map_err(database_error)
}

fn find(connection: &Connection, id: &str) -> Result<Album, String> {
    let store_id: Option<String> =
        connection.query_row("SELECT store_id FROM albums WHERE id = ?1", [id], |row| row.get(0)).optional().map_err(database_error)?;
    let store_id = store_id.ok_or_else(|| "This album no longer exists.".to_string())?;
    list(connection, &store_id)
        .map_err(database_error)?
        .into_iter()
        .find(|album| album.id == id)
        .ok_or_else(|| "This album no longer exists.".to_string())
}

fn checked_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the album a name.".into());
    }
    Ok(name.chars().take(120).collect())
}

/// The parent an album may be given: it must be in the same store and not below the album itself,
/// which would cut the branch off from the tree.
fn checked_parent(connection: &Connection, store_id: &str, id: &str, parent_id: &str) -> Result<String, String> {
    if parent_id.is_empty() {
        return Ok(String::new());
    }
    if parent_id == id {
        return Err("An album cannot hold itself.".into());
    }
    let mut walked = parent_id.to_string();
    // Albums are few and the walk is bounded by the tree's depth, but a broken row must not loop.
    for _ in 0..1000 {
        let row: Option<(String, String)> = connection
            .query_row("SELECT parent_id, store_id FROM albums WHERE id = ?1", [&walked], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(database_error)?;
        let Some((parent, parent_store)) = row else { return Err("That album no longer exists.".into()) };
        if parent_store != store_id {
            return Err("An album can only be moved inside its own store.".into());
        }
        // The top is reached first: a new album has no id yet, which would match the top's empty parent.
        if parent.is_empty() {
            return Ok(parent_id.to_string());
        }
        if parent == id {
            return Err("An album cannot be moved into one of its own albums.".into());
        }
        walked = parent;
    }
    Err("These albums hold each other.".into())
}

#[tauri::command]
pub fn album_create(store_id: String, name: String, parent_id: String) -> Result<Album, String> {
    let store = stores::find_store(&store_id)?;
    let connection = db::settings_db();
    let name = checked_name(&name)?;
    let parent_id = checked_parent(&connection, &store.id, "", &parent_id)?;
    let album = Album { id: stores::new_id(), store_id: store.id, parent_id, full_name: name.clone(), name, created_ms: now_ms(), ..Default::default() };
    connection
        .execute(
            "INSERT INTO albums (id, store_id, parent_id, name, cover_path, created_ms) VALUES (?1, ?2, ?3, ?4, '', ?5)",
            params![album.id, album.store_id, album.parent_id, album.name, album.created_ms as i64],
        )
        .map_err(database_error)?;
    Ok(album)
}

#[tauri::command]
pub fn album_rename(id: String, name: String) -> Result<Album, String> {
    let connection = db::settings_db();
    let name = checked_name(&name)?;
    let changed = connection.execute("UPDATE albums SET name = ?1 WHERE id = ?2", params![name, id]).map_err(database_error)?;
    if changed == 0 {
        return Err("This album no longer exists.".into());
    }
    find(&connection, &id)
}

/// Moves an album into another one, or to the top level when `parent_id` is empty.
#[tauri::command]
pub fn album_move(id: String, parent_id: String) -> Result<Album, String> {
    let connection = db::settings_db();
    let store_id: Option<String> =
        connection.query_row("SELECT store_id FROM albums WHERE id = ?1", [&id], |row| row.get(0)).optional().map_err(database_error)?;
    let store_id = store_id.ok_or_else(|| "This album no longer exists.".to_string())?;
    let parent_id = checked_parent(&connection, &store_id, &id, &parent_id)?;
    connection.execute("UPDATE albums SET parent_id = ?1 WHERE id = ?2", params![parent_id, id]).map_err(database_error)?;
    find(&connection, &id)
}

/// Shows `path` for the album, or the newest picture below it again when `path` is empty.
#[tauri::command]
pub fn album_set_cover(id: String, path: String) -> Result<Album, String> {
    let connection = db::settings_db();
    let changed = connection.execute("UPDATE albums SET cover_path = ?1 WHERE id = ?2", params![path, id]).map_err(database_error)?;
    if changed == 0 {
        return Err("This album no longer exists.".into());
    }
    find(&connection, &id)
}

/// Deletes an album and every album inside it. The pictures stay on disk and in the store.
#[tauri::command]
pub fn album_delete(id: String) -> Result<(), String> {
    let mut connection = db::settings_db();
    let transaction = connection.transaction().map_err(database_error)?;
    transaction
        .execute(&format!("{BRANCH} DELETE FROM album_pictures WHERE album_id IN (SELECT id FROM branch)"), [&id])
        .map_err(database_error)?;
    transaction.execute(&format!("{BRANCH} DELETE FROM albums WHERE id IN (SELECT id FROM branch)"), [&id]).map_err(database_error)?;
    transaction.commit().map_err(database_error)?;
    Ok(())
}

/// Adds pictures of the album's store, keeping the ones already there. Returns the album with its new
/// counts.
#[tauri::command]
pub fn album_add(id: String, paths: Vec<String>) -> Result<Album, String> {
    change_pictures(&id, &paths, true)
}

#[tauri::command]
pub fn album_remove(id: String, paths: Vec<String>) -> Result<Album, String> {
    change_pictures(&id, &paths, false)
}

fn change_pictures(id: &str, paths: &[String], add: bool) -> Result<Album, String> {
    let album = find(&db::settings_db(), id)?;
    let store = stores::find_store(&album.store_id)?;
    let inside: Vec<&String> = paths.iter().filter(|path| Path::new(path).starts_with(&store.path)).collect();
    if inside.is_empty() {
        return Err(format!("These pictures are not in the store \"{}\".", store.name));
    }
    let mut connection = db::settings_db();
    let transaction = connection.transaction().map_err(database_error)?;
    {
        let added = now_ms() as i64;
        let statement = if add { "INSERT OR IGNORE INTO album_pictures (album_id, path, added_ms) VALUES (?1, ?2, ?3)" } else { "DELETE FROM album_pictures WHERE album_id = ?1 AND path = ?2 AND ?3 >= 0" };
        let mut statement = transaction.prepare(statement).map_err(database_error)?;
        for path in inside {
            statement.execute(params![id, path, added]).map_err(database_error)?;
        }
    }
    transaction.commit().map_err(database_error)?;
    find(&connection, id)
}

/// The pictures of an album, and of every album inside it, as paths the gallery filters by.
#[tauri::command]
pub fn album_pictures(id: String) -> Result<Vec<String>, String> {
    let connection = db::settings_db();
    let mut statement = connection
        .prepare(&format!("{BRANCH} SELECT DISTINCT album_pictures.path FROM branch JOIN album_pictures ON album_pictures.album_id = branch.id"))
        .map_err(database_error)?;
    let paths = statement.query_map([&id], |row| row.get(0)).map_err(database_error)?;
    paths.collect::<rusqlite::Result<_>>().map_err(database_error)
}

/// Which albums each picture of a store is in, by their whole names such as `Trips/Rome`.
#[tauri::command]
pub fn store_album_index(store_id: String) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let store = stores::find_store(&store_id)?;
    let connection = db::settings_db();
    let albums = list(&connection, &store.id).map_err(database_error)?;
    let by_id: std::collections::HashMap<&str, &Album> = albums.iter().map(|album| (album.id.as_str(), album)).collect();
    let full_name = |album: &Album| {
        let mut parts = vec![album.name.clone()];
        let mut parent = album.parent_id.as_str();
        // Bounded, so a broken row cannot loop.
        for _ in 0..100 {
            let Some(above) = by_id.get(parent) else { break };
            parts.push(above.name.clone());
            parent = above.parent_id.as_str();
        }
        parts.reverse();
        parts.join("/")
    };
    let names: std::collections::HashMap<&str, String> = albums.iter().map(|album| (album.id.as_str(), full_name(album))).collect();
    let mut statement = connection
        .prepare("SELECT album_pictures.path, album_pictures.album_id FROM album_pictures JOIN albums ON albums.id = album_pictures.album_id WHERE albums.store_id = ?1")
        .map_err(database_error)?;
    let rows = statement.query_map([&store.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(database_error)?;
    let mut index: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for row in rows {
        let (path, album) = row.map_err(database_error)?;
        if let Some(name) = names.get(album.as_str()) {
            index.entry(path).or_default().push(name.clone());
        }
    }
    for found in index.values_mut() {
        found.sort_by_key(|name| name.to_lowercase());
        found.dedup();
    }
    Ok(index)
}

/// The albums of a store holding `path` directly, to mark them in menus.
#[tauri::command]
pub fn albums_of_picture(path: String) -> Result<Vec<String>, String> {
    let connection = db::settings_db();
    let mut statement = connection.prepare("SELECT album_id FROM album_pictures WHERE path = ?1").map_err(database_error)?;
    let ids = statement.query_map([&path], |row| row.get(0)).map_err(database_error)?;
    ids.collect::<rusqlite::Result<_>>().map_err(database_error)
}

/// Drops a deleted picture from every album, and from the covers showing it.
pub fn forget_picture(path: &str) {
    let connection = db::settings_db();
    if let Err(error) = connection.execute("DELETE FROM album_pictures WHERE path = ?1", [path]) {
        eprintln!("Cannot update the albums: {error}");
    }
    if let Err(error) = connection.execute("UPDATE albums SET cover_path = '' WHERE cover_path = ?1", [path]) {
        eprintln!("Cannot update the album covers: {error}");
    }
}

/// Removes the albums of a store that is being forgotten.
pub(crate) fn forget_store(connection: &Connection, store_id: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM album_pictures WHERE album_id IN (SELECT id FROM albums WHERE store_id = ?1)", [store_id])?;
    connection.execute("DELETE FROM albums WHERE store_id = ?1", [store_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(db::SETTINGS_SCHEMA).unwrap();
        connection
    }

    fn album(connection: &Connection, id: &str, parent: &str, name: &str) {
        connection
            .execute(
                "INSERT INTO albums (id, store_id, parent_id, name, cover_path, created_ms) VALUES (?1, 's', ?2, ?3, '', 0)",
                params![id, parent, name],
            )
            .unwrap();
    }

    fn picture(connection: &Connection, album_id: &str, path: &str, added: i64) {
        connection.execute("INSERT INTO album_pictures (album_id, path, added_ms) VALUES (?1, ?2, ?3)", params![album_id, path, added]).unwrap();
    }

    #[test]
    fn the_album_index_names_albums_with_their_parents() {
        let root = tempfile::tempdir().unwrap();
        let store = stores::create("Index".into(), super::super::path_string(root.path())).unwrap();
        let trips = album_create(store.id.clone(), "Trips".into(), String::new()).unwrap();
        let rome = album_create(store.id.clone(), "Rome".into(), trips.id.clone()).unwrap();
        let picture = format!("{}/ab/cd/abcd.jpg", store.path);
        album_add(rome.id.clone(), vec![picture.clone()]).unwrap();
        album_add(trips.id.clone(), vec![picture.clone()]).unwrap();
        let index = store_album_index(store.id.clone()).unwrap();
        assert_eq!(index.get(&picture).cloned().unwrap_or_default(), ["Trips", "Trips/Rome"]);
        assert_eq!(index.len(), 1);
        album_delete(trips.id).unwrap();
        assert!(store_album_index(store.id).unwrap().is_empty());
    }

    #[test]
    fn a_parent_counts_and_shows_the_pictures_below_it() {
        let connection = prepared();
        album(&connection, "trips", "", "Trips");
        album(&connection, "rome", "trips", "Rome");
        album(&connection, "other", "", "Other");
        picture(&connection, "trips", "/s/ab/cd/abcd1.jpg", 10);
        picture(&connection, "rome", "/s/ab/cd/abcd2.jpg", 30);
        // The same picture in a parent and a child counts once.
        picture(&connection, "rome", "/s/ab/cd/abcd1.jpg", 20);
        let albums = list(&connection, "s").unwrap();
        let by_id = |id: &str| albums.iter().find(|album| album.id == id).unwrap().clone();
        assert_eq!((by_id("trips").count, by_id("trips").total), (1, 2));
        assert_eq!((by_id("rome").count, by_id("rome").total), (2, 2));
        assert_eq!((by_id("other").count, by_id("other").total), (0, 0));
        // Without a chosen cover, the newest picture below the album stands in.
        assert_eq!(by_id("trips").cover_path, "/s/ab/cd/abcd2.jpg");
        assert_eq!(by_id("other").cover_path, "");
        connection.execute("UPDATE albums SET cover_path = '/s/ab/cd/abcd1.jpg' WHERE id = 'trips'", []).unwrap();
        assert_eq!(list(&connection, "s").unwrap().iter().find(|album| album.id == "trips").unwrap().cover_path, "/s/ab/cd/abcd1.jpg");
        // Albums come out sorted by name, whatever their place in the tree.
        assert_eq!(albums.iter().map(|album| album.name.as_str()).collect::<Vec<_>>(), ["Other", "Rome", "Trips"]);
    }

    #[test]
    fn an_album_cannot_be_moved_into_its_own_branch() {
        let connection = prepared();
        album(&connection, "trips", "", "Trips");
        album(&connection, "rome", "trips", "Rome");
        album(&connection, "ruins", "rome", "Ruins");
        connection
            .execute("INSERT INTO albums (id, store_id, parent_id, name, cover_path, created_ms) VALUES ('elsewhere', 'other', '', 'Elsewhere', '', 0)", [])
            .unwrap();
        assert!(checked_parent(&connection, "s", "trips", "ruins").is_err());
        assert!(checked_parent(&connection, "s", "trips", "trips").is_err());
        assert!(checked_parent(&connection, "s", "trips", "elsewhere").is_err());
        assert!(checked_parent(&connection, "s", "trips", "gone").is_err());
        assert_eq!(checked_parent(&connection, "s", "ruins", "trips").unwrap(), "trips");
        assert_eq!(checked_parent(&connection, "s", "ruins", "").unwrap(), "");
    }

    #[test]
    fn deleting_an_album_takes_the_albums_inside_it() {
        let connection = prepared();
        album(&connection, "trips", "", "Trips");
        album(&connection, "rome", "trips", "Rome");
        album(&connection, "kept", "", "Kept");
        picture(&connection, "rome", "/s/ab/cd/abcd1.jpg", 10);
        picture(&connection, "kept", "/s/ab/cd/abcd1.jpg", 10);
        connection.execute(&format!("{BRANCH} DELETE FROM album_pictures WHERE album_id IN (SELECT id FROM branch)"), ["trips"]).unwrap();
        connection.execute(&format!("{BRANCH} DELETE FROM albums WHERE id IN (SELECT id FROM branch)"), ["trips"]).unwrap();
        let albums = list(&connection, "s").unwrap();
        assert_eq!(albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(), ["kept"]);
        assert_eq!(albums[0].total, 1, "the picture stays in the albums that were kept");
    }

    #[test]
    fn forgetting_a_store_removes_its_albums_only() {
        let connection = prepared();
        album(&connection, "trips", "", "Trips");
        picture(&connection, "trips", "/s/ab/cd/abcd1.jpg", 10);
        connection
            .execute("INSERT INTO albums (id, store_id, parent_id, name, cover_path, created_ms) VALUES ('elsewhere', 'other', '', 'Elsewhere', '', 0)", [])
            .unwrap();
        picture(&connection, "elsewhere", "/o/ab/cd/abcd1.jpg", 10);
        forget_store(&connection, "s").unwrap();
        assert!(list(&connection, "s").unwrap().is_empty());
        assert_eq!(list(&connection, "other").unwrap()[0].total, 1);
    }

    #[test]
    fn pictures_and_covers_survive_only_while_the_file_does() {
        let connection = prepared();
        album(&connection, "trips", "", "Trips");
        picture(&connection, "trips", "/s/ab/cd/abcd1.jpg", 10);
        connection.execute("UPDATE albums SET cover_path = '/s/ab/cd/abcd1.jpg' WHERE id = 'trips'", []).unwrap();
        connection.execute("DELETE FROM album_pictures WHERE path = '/s/ab/cd/abcd1.jpg'", []).unwrap();
        connection.execute("UPDATE albums SET cover_path = '' WHERE cover_path = '/s/ab/cd/abcd1.jpg'", []).unwrap();
        let albums = list(&connection, "s").unwrap();
        assert_eq!((albums[0].total, albums[0].cover_path.as_str()), (0, ""));
    }
}
