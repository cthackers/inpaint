use serde::Serialize;
use std::{collections::HashSet, fs::File, io, path::Path};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize)]
pub struct ExportFailure {
    path: String,
    error: String,
}

#[derive(Default, Serialize)]
pub struct ExportResult {
    copied: usize,
    failures: Vec<ExportFailure>,
}

/// Copy bytes without decoding, preserving animation, embedded metadata and image quality.
/// Publish a complete file only, and never replace an existing destination (including symlinks).
fn copy_picture(source: &Path, destination: &Path) -> Result<(), String> {
    let name = source.file_name().ok_or("The picture has no filename.")?;
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let metadata = input.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("The source is not a regular file.".into());
    }
    let mut temporary = tempfile::Builder::new().prefix(".inpaint-export-")
        .tempfile_in(destination).map_err(|error| error.to_string())?;
    io::copy(&mut input, &mut temporary).map_err(|error| error.to_string())?;
    if let Ok(modified) = metadata.modified() {
        let _ = temporary.as_file().set_modified(modified);
    }
    temporary.as_file().sync_all().map_err(|error| error.to_string())?;
    let mut target = destination.join(name);
    for suffix in 1.. {
        match temporary.persist_noclobber(&target) {
            Ok(_) => return Ok(()),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                temporary = error.file;
                let mut name = source.file_stem().unwrap_or(name).to_os_string();
                name.push(format!(" ({suffix})"));
                if let Some(extension) = source.extension() {
                    name.push(".");
                    name.push(extension);
                }
                target = destination.join(name);
            }
            Err(error) => return Err(error.error.to_string()),
        }
    }
    unreachable!()
}

fn copy_pictures(paths: Vec<String>, destination: &Path, progress: impl Fn(ExportProgress)) -> Result<ExportResult, String> {
    if !destination.is_dir() {
        return Err("Choose an existing destination folder.".into());
    }
    // A picture in several nested albums is exported once, including aliases of the same path.
    let mut seen = HashSet::new();
    let paths: Vec<_> = paths.into_iter().filter(|path| {
        seen.insert(std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf()))
    }).collect();
    let total = paths.len();
    let mut result = ExportResult::default();
    progress(ExportProgress { done: 0, total });
    for (index, path) in paths.into_iter().enumerate() {
        match copy_picture(Path::new(&path), destination) {
            Ok(()) => result.copied += 1,
            Err(error) => result.failures.push(ExportFailure { path, error }),
        }
        progress(ExportProgress { done: index + 1, total });
    }
    Ok(result)
}

#[tauri::command]
pub async fn export_pictures(paths: Vec<String>, destination: String, on_progress: tauri::ipc::Channel<ExportProgress>) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_pictures(paths, Path::new(&destination), |progress| { let _ = on_progress.send(progress); })
    }).await.map_err(|error| format!("Export failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, fs};

    #[test]
    fn copies_exact_bytes_deduplicates_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        let output = root.path().join("output");
        for folder in [&first, &second, &output] { fs::create_dir(folder).unwrap(); }
        let name = "photo #é.gif";
        fs::write(first.join(name), b"first animated image and metadata").unwrap();
        fs::write(second.join(name), b"second image").unwrap();
        fs::write(output.join(name), b"already here").unwrap();
        let paths = vec![first.join(name), first.join(".").join(name), second.join(name)];
        let updates = RefCell::new(Vec::new());
        let result = copy_pictures(paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(), &output,
            |p| updates.borrow_mut().push((p.done, p.total))).unwrap();
        assert_eq!(result.copied, 2);
        assert!(result.failures.is_empty());
        assert_eq!(fs::read(output.join(name)).unwrap(), b"already here");
        assert_eq!(fs::read(output.join("photo #é (1).gif")).unwrap(), fs::read(first.join(name)).unwrap());
        assert_eq!(fs::read(output.join("photo #é (2).gif")).unwrap(), fs::read(second.join(name)).unwrap());
        assert_eq!(*updates.borrow(), [(0, 2), (1, 2), (2, 2)]);
        assert_eq!(fs::read_dir(output).unwrap().count(), 3);
    }

    #[test]
    fn missing_files_are_reported_and_other_files_still_export() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        fs::create_dir(&output).unwrap();
        let source = root.path().join("photo.png");
        fs::write(&source, b"saved image").unwrap();
        let missing = root.path().join("missing.png").to_string_lossy().into_owned();
        let result = copy_pictures(vec![missing.clone(), source.to_string_lossy().into_owned()], &output, |_| {}).unwrap();
        assert_eq!(result.copied, 1);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].path, missing);
        assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
        assert!(copy_pictures(vec![], &source, |_| {}).is_err());
        assert_eq!(copy_pictures(vec![], &output, |_| {}).unwrap().copied, 0);
    }

    #[cfg(unix)]
    #[test]
    fn exporting_beside_the_source_and_existing_symlinks_is_safe() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("image.png");
        fs::write(&source, b"original").unwrap();
        std::os::unix::fs::symlink(&source, root.path().join("image (1).png")).unwrap();
        copy_picture(&source, root.path()).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert!(root.path().join("image (1).png").is_symlink());
        assert_eq!(fs::read(root.path().join("image (2).png")).unwrap(), b"original");
    }
}
