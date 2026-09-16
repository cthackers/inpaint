//! Animated GIFs: every frame read out for the editor, which edits them one by one, and written back
//! as an animation after Save.

use image::{
    codecs::gif::{GifDecoder, GifEncoder, Repeat},
    AnimationDecoder, Delay, Frame, RgbaImage,
};
use base64::Engine;
use serde::Serialize;
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
};

/// Frames and pixels an animation may have to be edited as one; a longer one is saved as a still picture.
const MAX_FRAMES: usize = 1000;
const MAX_PIXELS: u64 = 150_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    /// Each frame whole, as a PNG data URL the editor can work on.
    frames: Vec<String>,
    /// How long each frame shows, in milliseconds.
    delays: Vec<u32>,
}

/// The frames of a GIF, each drawn over the ones before as a viewer shows it, with their delays.
fn decode(bytes: &[u8]) -> Result<Vec<(RgbaImage, u32)>, String> {
    let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|error| format!("Cannot read the animation: {error}"))?;
    let mut frames = Vec::new();
    let mut pixels = 0u64;
    for frame in decoder.into_frames() {
        let frame = frame.map_err(|error| format!("Cannot read the animation: {error}"))?;
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        let delay = if denominator == 0 { 100 } else { numerator / denominator };
        let buffer = frame.into_buffer();
        pixels += u64::from(buffer.width()) * u64::from(buffer.height());
        frames.push((buffer, delay));
        if frames.len() > MAX_FRAMES || pixels > MAX_PIXELS {
            return Err(too_long());
        }
    }
    Ok(frames)
}

fn too_long() -> String {
    format!("This animation is too long to edit every frame (more than {MAX_FRAMES} frames or {} megapixels in all).", MAX_PIXELS / 1_000_000)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    frames: usize,
    /// Whether every frame can be edited and saved, which needs them all in memory.
    editable: bool,
}

/// Counts the frames without keeping them.
fn info(bytes: &[u8]) -> Result<Info, String> {
    let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|error| format!("Cannot read the animation: {error}"))?;
    let (width, height) = image::ImageDecoder::dimensions(&decoder);
    let mut frames = 0;
    for frame in decoder.into_frames() {
        frame.map_err(|error| format!("Cannot read the animation: {error}"))?;
        frames += 1;
    }
    let pixels = frames as u64 * u64::from(width) * u64::from(height);
    Ok(Info { frames, editable: frames <= MAX_FRAMES && pixels <= MAX_PIXELS })
}

fn encode(frames: Vec<(RgbaImage, u32)>) -> Result<Vec<u8>, String> {
    let failed = |error: image::ImageError| format!("Cannot write the animation: {error}");
    let mut bytes = Vec::new();
    {
        // Speed 10 of 30 keeps colours close without taking long on many frames.
        let mut encoder = GifEncoder::new_with_speed(&mut bytes, 10);
        encoder.set_repeat(Repeat::Infinite).map_err(failed)?;
        encoder
            .encode_frames(frames.into_iter().map(|(buffer, delay)| Frame::from_parts(buffer, 0, 0, Delay::from_numer_denom_ms(delay.max(10), 1))))
            .map_err(failed)?;
    }
    Ok(bytes)
}

/// A GIF of at most 480×360 with every frame, for the gallery.
pub fn thumbnail(path: &Path) -> Result<Vec<u8>, String> {
    if let Ok(result) = Command::new("magick")
        .env("MAGICK_THREAD_LIMIT", "1")
        .arg(path)
        .args(["-coalesce", "-resize", "480x360>", "-layers", "Optimize", "gif:-"])
        .output()
    {
        if result.status.success() && !result.stdout.is_empty() {
            return Ok(result.stdout);
        }
    }
    let bytes = std::fs::read(path).map_err(|error| format!("Cannot read image: {error}"))?;
    let frames = decode(&bytes)?
        .into_iter()
        .map(|(buffer, delay)| (image::DynamicImage::ImageRgba8(buffer).thumbnail(480, 360).to_rgba8(), delay))
        .collect();
    encode(frames)
}

/// How many frames a GIF has; None for a still picture.
#[tauri::command]
pub async fn animation_info(path: String) -> Result<Option<Info>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if super::image_extension(&path).as_deref() != Some("gif") {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).map_err(|error| format!("Cannot read image: {error}"))?;
        info(&bytes).map(|info| (info.frames > 1).then_some(info))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Every frame of an animated GIF; None for a still picture.
#[tauri::command]
pub async fn read_animation(path: String) -> Result<Option<Animation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if super::image_extension(&path).as_deref() != Some("gif") {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).map_err(|error| format!("Cannot read image: {error}"))?;
        let frames = decode(&bytes)?;
        if frames.len() < 2 {
            return Ok(None);
        }
        let mut animation = Animation { frames: Vec::with_capacity(frames.len()), delays: Vec::with_capacity(frames.len()) };
        for (buffer, delay) in frames {
            let png = super::encode_image(&image::DynamicImage::ImageRgba8(buffer), image::ImageFormat::Png)?;
            animation.frames.push(format!("data:image/png;base64,{}", super::BASE64.encode(png)));
            animation.delays.push(delay);
        }
        Ok(Some(animation))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Writes the edited frames back over the GIF. Returns the same note Save gives for Immich stores.
#[tauri::command]
pub async fn save_animation(path: String, frames: Vec<String>, delays: Vec<u32>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if super::image_extension(&path).as_deref() != Some("gif") {
            return Err("An animation can only be saved as a GIF.".into());
        }
        if frames.is_empty() || frames.len() != delays.len() {
            return Err("The animation has no frames to save.".into());
        }
        let mut decoded = Vec::with_capacity(frames.len());
        for (frame, delay) in frames.iter().zip(delays) {
            let bytes = super::decode_data_url(frame)?;
            let image = image::load_from_memory(&bytes).map_err(|error| format!("Cannot decode an edited frame: {error}"))?.to_rgba8();
            decoded.push((image, delay));
        }
        let (width, height) = decoded[0].0.dimensions();
        if decoded.iter().any(|(image, _)| image.dimensions() != (width, height)) {
            return Err("The edited frames are not all the same size.".into());
        }
        let previous = image::image_dimensions(&path).ok();
        super::replace_file(&path, &encode(decoded)?)?;
        let saved = std::fs::canonicalize(&path).unwrap_or(path);
        super::stores::record_picture(&saved);
        Ok(super::immich::refresh_saved_picture(&saved, previous != Some((width, height))))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(red: u8) -> RgbaImage {
        RgbaImage::from_pixel(6, 4, image::Rgba([red, 20, 30, 255]))
    }

    #[test]
    fn frames_and_delays_survive_a_round_trip() {
        let bytes = encode(vec![(frame(200), 80), (frame(40), 120), (frame(120), 50)]).unwrap();
        let read = decode(&bytes).unwrap();
        assert_eq!(read.len(), 3);
        assert_eq!(read.iter().map(|(_, delay)| *delay).collect::<Vec<_>>(), [80, 120, 50]);
        assert_eq!(read[1].0.dimensions(), (6, 4));
        // GIF colours are quantized, so each frame keeps its colour only approximately.
        let red = read[0].0.get_pixel(1, 1)[0];
        assert!((i32::from(red) - 200).abs() < 16, "{red}");
    }

    #[test]
    fn too_many_frames_are_refused() {
        let frames = (0..MAX_FRAMES + 1).map(|at| (frame(at as u8), 20)).collect();
        let bytes = encode(frames).unwrap();
        assert!(decode(&bytes).unwrap_err().contains("too long"));
        let counted = info(&bytes).unwrap();
        assert_eq!(counted.frames, MAX_FRAMES + 1);
        assert!(!counted.editable);
    }
}
