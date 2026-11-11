use gtk::{gio, glib};
use image::ImageDecoder;
use std::{path::Path, process::Command};

/// Ask the desktop file manager to select this file; older managers can still open its folder.
#[tauri::command]
pub async fn reveal_image(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use gio::prelude::FileExt;
        use glib::variant::ToVariant;

        let file = std::fs::canonicalize(&path).map_err(|error| format!("Cannot find {path}: {error}"))?;
        if !file.is_file() {
            return Err(format!("{path} is not a file."));
        }
        let uri = gio::File::for_path(&file).uri().to_string();
        let revealed = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
            .and_then(|bus| bus.call_sync(
                Some("org.freedesktop.FileManager1"), "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1", "ShowItems",
                Some(&(vec![uri], "").to_variant()), None,
                gio::DBusCallFlags::NONE, 5000, gio::Cancellable::NONE,
            ));
        if revealed.is_ok() {
            return Ok(());
        }
        let folder = file.parent().ok_or("The file has no parent folder.")?;
        let result = Command::new("xdg-open").arg(folder).output()
            .map_err(|error| format!("Cannot open the file explorer: {error}"))?;
        if !result.status.success() {
            return Err(format!("Cannot open the file explorer: {}", String::from_utf8_lossy(&result.stderr).trim()));
        }
        Ok(())
    }).await.map_err(|error| format!("Cannot show the file: {error}"))?
}

fn clipboard_pixels(path: &Path) -> Result<image::RgbaImage, String> {
    let mut decoder = image::ImageReader::open(path)
        .map_err(|error| format!("Cannot read the image: {error}"))?
        .with_guessed_format().map_err(|error| format!("Cannot read the image format: {error}"))?
        .into_decoder().map_err(|error| format!("Cannot decode the image: {error}"))?;
    let orientation = decoder.orientation().map_err(|error| format!("Cannot read image orientation: {error}"))?;
    let mut image = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Cannot decode the image: {error}"))?;
    image.apply_orientation(orientation);
    Ok(image.to_rgba8())
}

/// Decode off the UI thread, then give GTK ownership of the pixels on its main thread.
#[tauri::command]
pub async fn copy_image_to_clipboard(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let pixels = tauri::async_runtime::spawn_blocking(move || clipboard_pixels(Path::new(&path)))
        .await.map_err(|error| format!("Cannot prepare the clipboard image: {error}"))??;
    let width = i32::try_from(pixels.width()).map_err(|_| "The image is too wide to copy.")?;
    let height = i32::try_from(pixels.height()).map_err(|_| "The image is too tall to copy.")?;
    let stride = width.checked_mul(4).ok_or("The image is too wide to copy.")?;
    if width == 0 || height == 0 {
        return Err("The image is empty.".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_mut_slice(
            pixels.into_raw(), gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, width, height, stride,
        );
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        clipboard.set_image(&pixbuf);
        clipboard.store();
        let _ = sender.send(());
    }).map_err(|error| format!("Cannot access the clipboard: {error}"))?;
    receiver.await.map_err(|_| "Cannot copy the image to the clipboard.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_preserves_pixels_and_transparency() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("photo with spaces #é.png");
        let original = image::RgbaImage::from_fn(3, 2, |x, y| image::Rgba([x as u8 * 50, y as u8 * 80, 200, 120]));
        original.save(&path).unwrap();
        assert_eq!(clipboard_pixels(&path).unwrap(), original);
    }

    #[test]
    fn clipboard_applies_camera_orientation() {
        use image::ImageEncoder;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rotated.jpg");
        let original = image::RgbImage::from_fn(3, 2, |x, y| image::Rgb([x as u8 * 80, y as u8 * 120, 200]));
        let mut encoded = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut encoded);
        // Little-endian TIFF header, one SHORT orientation entry: 6 means rotate 90° clockwise.
        encoder.set_exif_metadata(vec![
            b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0,
            0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ]).unwrap();
        encoder.encode_image(&original).unwrap();
        std::fs::write(&path, &encoded).unwrap();
        let expected = image::load_from_memory(&encoded).unwrap().rotate90().to_rgba8();
        assert_eq!(clipboard_pixels(&path).unwrap(), expected);
    }

    #[test]
    fn clipboard_rejects_missing_and_invalid_images() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("invalid.png");
        assert!(clipboard_pixels(&path).is_err());
        std::fs::write(&path, b"not an image").unwrap();
        assert!(clipboard_pixels(&path).is_err());
    }
}
