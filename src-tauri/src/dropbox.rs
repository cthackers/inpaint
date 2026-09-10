//! Drop box: a small always-on-top area in a corner of a screen that saves pictures dropped on it,
//! or copied, into an image store.
//!
//! The area stays mapped, invisible and click-through. Holding Win+Ctrl fades it in; the keys
//! are polled with XQueryKeymap, which also sees keys that other programs grab. Pressing V while
//! holding them saves the clipboard. Pictures are named after their SHA-1 as `ab/cd/<sha1>.<ext>`,
//! and a picture whose hash is already in the store is skipped. Immich-compatible stores upload
//! through Immich instead, which files the picture itself and skips pictures it already has.
//!
//! Drops are read natively from GTK rather than from the page, whose DataTransfer offers only links
//! and text. Chromium offers a dragged picture's own bytes as application/octet-stream, so pictures
//! behind a login save without downloading them again.
//!
//! KWin fades the whole window through its opacity (`_NET_WM_WINDOW_OPACITY`, set with GTK). A
//! transparent webview measured opaque on WebKitGTK with NVIDIA and kept old frames on screen.

use super::{
    immich,
    stores::{self, Store},
    ImageEntry,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    fmt::Display,
    fs,
    io::{self, Read},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "dropbox";

/// What the drop box accepts: the formats stores list, plus web and phone formats kept for Immich
/// and other viewers.
const PICTURE_EXTENSIONS: [&str; 11] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif"];

/// Drag targets that carry a picture's bytes, as other programs such as Firefox offer them.
const PICTURE_TARGETS: [&str; 9] = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp", "image/tiff", "image/heic", "image/heif"];
const TEXT_TARGETS: [&str; 5] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT"];
/// How long a failure stays on the area, kept clearly visible so it can be read.
const FAILURE_MS: u64 = 8000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DropboxSettings {
    pub enabled: bool,
    pub store_id: String,
    /// Always visible instead of only while Win+Ctrl is held.
    pub pinned: bool,
    pub width: u32,
    pub height: u32,
    pub margin: u32,
    pub opacity: f64,
    /// The screen, by horizontal position: left, middle or right.
    pub monitor: String,
}

impl Default for DropboxSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            store_id: String::new(),
            pinned: false,
            width: 200,
            height: 400,
            margin: 8,
            opacity: 0.2,
            monitor: "middle".into(),
        }
    }
}

#[derive(Default)]
pub struct DropboxState {
    settings: Mutex<DropboxSettings>,
    held: AtomicBool,
    /// Whether the keys can be watched, which needs an X11 session.
    hotkeys: AtomicBool,
    busy: AtomicUsize,
    /// Something is dragged over the area.
    dragging: AtomicBool,
    flashing: AtomicBool,
    /// Count flashes and fades, so a newer one stops an older one.
    flash: AtomicUsize,
    fade: AtomicUsize,
    shown_opacity: Mutex<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropboxStatus {
    settings: DropboxSettings,
    hotkeys: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    visible: bool,
    dragging: bool,
    store_name: Option<String>,
    busy: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DropReport {
    outcome: &'static str,
    message: String,
}

/// The links and text of a drop or the clipboard.
#[derive(Default)]
struct DropData {
    uris: Vec<String>,
    html: String,
    text: String,
}

enum Item {
    File(PathBuf),
    Url { url: String, page_images: Vec<String> },
    Bytes { data: Vec<u8>, name: String, mime: String },
    /// Text or HTML whose picture links are saved.
    Text { text: String, html: bool },
}

/// A drop being read: GTK hands over one target's data at a time.
struct NativeDrop {
    offered: Vec<String>,
    queue: VecDeque<String>,
    /// Links found so far, used only if no picture data follows.
    links: Vec<Item>,
}

enum Next {
    Request(String),
    Done(Vec<Item>),
    Nothing,
}

impl NativeDrop {
    /// The picture's own bytes first, then file lists, pictures other programs offer, links and text.
    fn targets() -> Vec<&'static str> {
        let mut order = vec!["application/octet-stream", "text/uri-list"];
        order.extend(PICTURE_TARGETS);
        order.extend(["text/x-moz-url", "_NETSCAPE_URL", "text/html"]);
        order.extend(TEXT_TARGETS);
        order
    }

    fn new(offered: Vec<String>) -> Self {
        let queue = Self::targets().into_iter().filter(|target| offered.iter().any(|offer| offer == target)).map(String::from).collect();
        Self { offered, queue, links: Vec::new() }
    }

    fn next_target(&mut self) -> Option<String> {
        self.queue.pop_front()
    }

    fn accept(&mut self, items: Vec<Item>) -> Next {
        let links_only = !items.is_empty() && items.iter().all(|item| matches!(item, Item::Url { .. }));
        if links_only && self.links.is_empty() {
            // Links may need a login to download, so first try a picture the source offers.
            self.links = items;
            self.queue.retain(|target| PICTURE_TARGETS.contains(&target.as_str()));
        } else if !items.is_empty() {
            return Next::Done(items);
        }
        match self.next_target() {
            Some(target) => Next::Request(target),
            None if !self.links.is_empty() => Next::Done(std::mem::take(&mut self.links)),
            None => Next::Nothing,
        }
    }
}

enum Outcome {
    Saved(Option<ImageEntry>),
    Duplicate,
}

/// A file ready to be hashed and stored; `temp` is set when it was written for the drop.
struct Staged {
    path: PathBuf,
    temp: Option<tempfile::TempPath>,
    extension: String,
    modified: SystemTime,
}

pub struct TrayInfo {
    pub enabled: bool,
    pub pinned: bool,
    pub store_index: usize,
    pub stores: Vec<(String, String)>,
}

pub fn settings(app: &AppHandle) -> DropboxSettings {
    app.state::<DropboxState>().settings.lock().unwrap().clone()
}

fn validated(mut settings: DropboxSettings) -> Result<DropboxSettings, String> {
    if !matches!(settings.monitor.as_str(), "left" | "middle" | "right") {
        settings.monitor = "middle".into();
    }
    if !(50..=4000).contains(&settings.width) || !(50..=4000).contains(&settings.height) {
        return Err("The drop box must be 50 to 4000 pixels wide and high.".into());
    }
    if settings.margin > 2000 {
        return Err("The margin must be at most 2000 pixels.".into());
    }
    if !(0.01..=1.0).contains(&settings.opacity) {
        return Err("The opacity must be between 0.01 and 1.".into());
    }
    Ok(settings)
}

pub fn start(app: &AppHandle) {
    let saved = super::db::setting("dropbox").and_then(Result::ok).and_then(|settings| validated(settings).ok()).unwrap_or_default();
    *app.state::<DropboxState>().settings.lock().unwrap() = saved;
    let handle = app.clone();
    if let Err(error) = std::thread::Builder::new().name("dropbox-keys".into()).spawn(move || watch_keys(handle)) {
        eprintln!("Cannot watch the drop box keys: {error}");
    }
    apply(app);
}

fn update(app: &AppHandle, change: impl FnOnce(&mut DropboxSettings)) -> Result<DropboxSettings, String> {
    let state = app.state::<DropboxState>();
    let mut next = state.settings.lock().unwrap().clone();
    change(&mut next);
    let next = validated(next)?;
    super::db::set_setting("dropbox", &next)?;
    *state.settings.lock().unwrap() = next.clone();
    apply(app);
    let _ = app.emit("dropbox-settings", &next);
    Ok(next)
}

pub fn set_enabled(app: &AppHandle, enabled: bool) {
    report_error(app, update(app, |settings| settings.enabled = enabled));
}

pub fn set_pinned(app: &AppHandle, pinned: bool) {
    report_error(app, update(app, |settings| settings.pinned = pinned));
}

pub fn set_store(app: &AppHandle, id: String) {
    report_error(app, update(app, |settings| settings.store_id = id));
}

fn report_error<T>(app: &AppHandle, result: Result<T, String>) {
    if let Err(error) = result {
        eprintln!("Cannot change the drop box: {error}");
        send_report(app, DropReport { outcome: "failed", message: error });
    }
}

/// Shows the main window on the drop box settings.
pub fn open_settings(app: &AppHandle) {
    super::tray::show_window(app);
    let _ = app.emit_to("main", "open-settings", "dropbox");
}

/// Opens, moves or closes the overlay after the settings changed.
fn apply(app: &AppHandle) {
    let settings = settings(app);
    match app.get_webview_window(LABEL) {
        Some(window) if !settings.enabled => {
            let _ = window.destroy();
        }
        Some(window) => place(&window, &settings),
        None if settings.enabled => {
            if let Err(error) = create_window(app, &settings) {
                eprintln!("Cannot open the drop box: {error}");
            }
        }
        None => {}
    }
    refresh(app);
}

/// Updates the overlay and the tray menu, also after stores were added, renamed or removed.
pub fn refresh(app: &AppHandle) {
    show_state(app);
    super::tray::refresh(app);
}

fn show_state(app: &AppHandle) {
    let state = overlay_state(app);
    let dropbox = app.state::<DropboxState>();
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_ignore_cursor_events(!state.visible);
        let emphasized = state.dragging || dropbox.flashing.load(Ordering::SeqCst);
        let target = target_opacity(state.visible, settings(app).opacity, emphasized);
        fade_to(app, &window, target);
    }
    let _ = app.emit_to(LABEL, "dropbox-state", state);
}

/// Dragging over the area and showing an outcome make it clearly visible.
fn target_opacity(visible: bool, opacity: f64, emphasized: bool) -> f64 {
    match (visible, emphasized) {
        (false, _) => 0.0,
        (true, true) => opacity.max(0.9),
        (true, false) => opacity,
    }
}

const FADE_STEPS: u32 = 6;

fn fade_to(app: &AppHandle, window: &WebviewWindow, target: f64) {
    let state = app.state::<DropboxState>();
    let start = *state.shown_opacity.lock().unwrap();
    if (start - target).abs() < 0.001 {
        return;
    }
    let generation = state.fade.fetch_add(1, Ordering::SeqCst) + 1;
    let (app, window) = (app.clone(), window.clone());
    std::thread::spawn(move || {
        let state = app.state::<DropboxState>();
        for step in 1..=FADE_STEPS {
            if state.fade.load(Ordering::SeqCst) != generation {
                return;
            }
            let value = start + (target - start) * step as f64 / FADE_STEPS as f64;
            let shown = window.clone();
            let _ = app.run_on_main_thread(move || {
                if let Ok(gtk_window) = shown.gtk_window() {
                    use gtk::prelude::WidgetExt;
                    gtk_window.set_opacity(value);
                }
            });
            *state.shown_opacity.lock().unwrap() = value;
            std::thread::sleep(Duration::from_millis(20));
        }
    });
}

/// Sends the overlay the outcome and shows the area clearly while it flashes.
fn send_report(app: &AppHandle, report: DropReport) {
    let milliseconds = match report.outcome {
        "failed" => FAILURE_MS,
        "duplicate" => 500,
        _ => 650,
    };
    let _ = app.emit_to(LABEL, "dropbox-result", report);
    let state = app.state::<DropboxState>();
    let generation = state.flash.fetch_add(1, Ordering::SeqCst) + 1;
    state.flashing.store(true, Ordering::SeqCst);
    show_state(app);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(milliseconds));
        let state = app.state::<DropboxState>();
        if state.flash.load(Ordering::SeqCst) == generation {
            state.flashing.store(false, Ordering::SeqCst);
            show_state(&app);
        }
    });
}

fn overlay_state(app: &AppHandle) -> OverlayState {
    let state = app.state::<DropboxState>();
    let settings = settings(app);
    let stores = stores::stores_list();
    OverlayState {
        visible: settings.enabled && (settings.pinned || state.held.load(Ordering::SeqCst)),
        dragging: state.dragging.load(Ordering::SeqCst),
        store_name: stores.into_iter().find(|store| store.id == settings.store_id).map(|store| store.name),
        busy: state.busy.load(Ordering::SeqCst),
    }
}

pub fn tray_info(app: &AppHandle) -> TrayInfo {
    let settings = settings(app);
    let stores: Vec<_> = stores::stores_list().into_iter().map(|store| (store.id, store.name)).collect();
    TrayInfo {
        enabled: settings.enabled,
        pinned: settings.pinned,
        store_index: stores.iter().position(|(id, _)| *id == settings.store_id).unwrap_or(usize::MAX),
        stores,
    }
}

fn create_window(app: &AppHandle, settings: &DropboxSettings) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Inpaint drop box")
        .inner_size(settings.width as f64, settings.height as f64)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        // The page reads drops itself: Tauri's handler only reports local file paths.
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| error.to_string())?;
    place(&window, settings);
    let native_app = app.clone();
    window
        .with_webview(move |webview| connect_native(&native_app, &webview.inner()))
        .map_err(|error| error.to_string())?;
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        // A utility window: no taskbar or pager entry, and no focus taken from the window dragged from.
        if let Ok(gtk_window) = window.gtk_window() {
            use gtk::prelude::{GtkWindowExt, WidgetExt};
            gtk_window.set_type_hint(gtk::gdk::WindowTypeHint::Utility);
            gtk_window.set_skip_pager_hint(true);
            gtk_window.set_accept_focus(false);
            // Start invisible; show_state fades it in when it should show. GTK passes opacity on to the
            // X window only once that exists, and ignores setting the same value again, so an opacity set
            // before realizing would leave the area mapped fully opaque.
            gtk_window.realize();
            gtk_window.set_opacity(0.0);
        }
        *app_handle.state::<DropboxState>().shown_opacity.lock().unwrap() = 0.0;
        let _ = window.show();
        // Click-through needs the native window, which exists once it is shown.
        show_state(&app_handle);
    })
    .map_err(|error| error.to_string())
}

/// Reads drops and right-clicks on the webview natively, stopping WebKit's own handling: its
/// DataTransfer has no picture bytes or files from other programs, and an HTML menu cannot leave the area.
fn connect_native<W: gtk::prelude::IsA<gtk::Widget> + 'static>(app: &AppHandle, webview: &W) {
    use gtk::{
        gdk::{Atom, DragAction},
        glib::Propagation,
        prelude::*,
    };
    let hovering = Rc::new(Cell::new(false));
    let hover: Rc<dyn Fn(bool)> = {
        let app = app.clone();
        Rc::new(move |over| {
            if hovering.replace(over) != over {
                app.state::<DropboxState>().dragging.store(over, Ordering::SeqCst);
                show_state(&app);
            }
        })
    };
    let session: Rc<RefCell<Option<NativeDrop>>> = Rc::default();
    // GTK only hands over data for targets in the widget's own list, and WebKit's has no picture bytes.
    let entries: Vec<_> = NativeDrop::targets().into_iter().map(|target| gtk::TargetEntry::new(target, gtk::TargetFlags::OTHER_APP, 0)).collect();
    webview.drag_dest_set_target_list(Some(&gtk::TargetList::new(&entries)));

    let motion_hover = hover.clone();
    webview.connect_drag_motion(move |_, context, _, _, time| {
        context.drag_status(DragAction::COPY, time);
        motion_hover(true);
        true
    });
    webview.connect_drag_leave(move |webview, _, _| {
        webview.stop_signal_emission_by_name("drag-leave");
        hover(false);
    });

    let (drops, drop_app, data_app) = (session.clone(), app.clone(), app.clone());
    webview.connect_drag_drop(move |webview, context, _, _, time| {
        let offered = context.list_targets().into_iter().map(|atom| atom.name().to_string()).collect();
        let mut drop = NativeDrop::new(offered);
        match drop.next_target() {
            Some(target) => {
                *drops.borrow_mut() = Some(drop);
                webview.drag_get_data(context, &Atom::intern(&target), time);
            }
            None => {
                context.drag_finish(false, false, time);
                send_report(&drop_app, nothing_offered(&drop.offered));
            }
        }
        true
    });
    webview.connect_drag_data_received(move |webview, context, _, _, data, _, time| {
        webview.stop_signal_emission_by_name("drag-data-received");
        let Some(mut drop) = session.borrow_mut().take() else { return };
        let items = selection_items(&data.target().name(), &data.data());
        match drop.accept(items) {
            Next::Request(target) => {
                *session.borrow_mut() = Some(drop);
                webview.drag_get_data(context, &Atom::intern(&target), time);
            }
            Next::Done(items) => {
                context.drag_finish(true, false, time);
                process(&data_app, items);
            }
            Next::Nothing => {
                context.drag_finish(false, false, time);
                send_report(&data_app, nothing_offered(&drop.offered));
            }
        }
    });

    let menu = gtk::Menu::new();
    menu.set_attach_widget(Some(webview));
    let menu_app = app.clone();
    webview.connect_button_press_event(move |_, event| {
        if event.button() != 3 {
            return Propagation::Proceed;
        }
        fill_menu(&menu, &menu_app);
        menu.popup_at_pointer(Some(&**event));
        Propagation::Stop
    });
}

/// The area's right-click menu, rebuilt each time from the current stores and settings.
fn fill_menu(menu: &gtk::Menu, app: &AppHandle) {
    use gtk::prelude::*;
    for child in menu.children() {
        menu.remove(&child);
    }
    let info = tray_info(app);
    let later = |app: &AppHandle, change: Box<dyn FnOnce(&AppHandle) + Send>| {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || change(&app));
    };
    let heading = gtk::MenuItem::with_label("Save into");
    heading.set_sensitive(false);
    menu.append(&heading);
    if info.stores.is_empty() {
        let none = gtk::MenuItem::with_label("No image stores yet");
        none.set_sensitive(false);
        menu.append(&none);
    }
    for (index, (id, name)) in info.stores.into_iter().enumerate() {
        let item = gtk::CheckMenuItem::with_label(&name);
        item.set_draw_as_radio(true);
        item.set_active(index == info.store_index);
        let app = app.clone();
        item.connect_activate(move |_| {
            let id = id.clone();
            later(&app, Box::new(move |app| set_store(app, id)));
        });
        menu.append(&item);
    }
    menu.append(&gtk::SeparatorMenuItem::new());
    let pinned = gtk::CheckMenuItem::with_label("Always visible");
    pinned.set_active(info.pinned);
    let pin_app = app.clone();
    pinned.connect_activate(move |_| later(&pin_app, Box::new(move |app| set_pinned(app, !info.pinned))));
    menu.append(&pinned);
    let clipboard = gtk::MenuItem::with_label("Save clipboard now");
    let clipboard_app = app.clone();
    clipboard.connect_activate(move |_| save_clipboard_soon(&clipboard_app));
    menu.append(&clipboard);
    let settings = gtk::MenuItem::with_label("Drop box settings…");
    let settings_app = app.clone();
    settings.connect_activate(move |_| open_settings(&settings_app));
    menu.append(&settings);
    menu.show_all();
}

fn nothing_offered(offered: &[String]) -> DropReport {
    let offered = if offered.is_empty() { "no data".to_string() } else { offered.iter().take(8).cloned().collect::<Vec<_>>().join(", ") };
    DropReport { outcome: "failed", message: format!("Nothing to save in this drop. It offered {offered}.") }
}

/// What one drag target's data holds. Text without links gives nothing, so the next target is tried.
fn selection_items(target: &str, bytes: &[u8]) -> Vec<Item> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let links = |urls: Vec<String>| urls.into_iter().map(|url| Item::Url { url, page_images: Vec::new() }).collect();
    match target {
        // Chromium's dragged picture, taken from the page it shows.
        "application/octet-stream" => vec![Item::Bytes { data: bytes.to_vec(), name: String::new(), mime: String::new() }],
        _ if PICTURE_TARGETS.contains(&target) => vec![Item::Bytes { data: bytes.to_vec(), name: String::new(), mime: target.into() }],
        "text/uri-list" => drop_items(DropData { uris: String::from_utf8_lossy(bytes).lines().map(String::from).collect(), ..Default::default() }),
        "text/x-moz-url" | "_NETSCAPE_URL" => clipboard_text(bytes)
            .lines()
            .next()
            .map(|url| drop_items(DropData { uris: vec![url.trim().to_string()], ..Default::default() }))
            .unwrap_or_default(),
        "text/html" => links(urls_in_text(&clipboard_text(bytes), true)),
        _ => links(urls_in_text(&clipboard_text(bytes), false)),
    }
}

/// Bottom-right corner of the chosen screen's work area.
fn place(window: &WebviewWindow, settings: &DropboxSettings) {
    let mut monitors = window.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return;
    }
    monitors.sort_by_key(|monitor| monitor.position().x);
    let monitor = match settings.monitor.as_str() {
        "left" => &monitors[0],
        "right" => &monitors[monitors.len() - 1],
        _ => &monitors[monitors.len() / 2],
    };
    let pixels = |value: u32| (value as f64 * monitor.scale_factor()).round() as i32;
    let (width, height, margin) = (pixels(settings.width), pixels(settings.height), pixels(settings.margin));
    let area = monitor.work_area();
    let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
    let _ = window.set_position(PhysicalPosition::new(
        area.position.x + area.size.width as i32 - width - margin,
        area.position.y + area.size.height as i32 - height - margin,
    ));
}

fn watch_keys(app: AppHandle) {
    use x11_dl::{keysym, xlib::Xlib};
    let Ok(xlib) = Xlib::open() else { return };
    let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
    if display.is_null() {
        return;
    }
    let codes = |symbols: &[u32]| -> Vec<u8> {
        symbols
            .iter()
            .map(|symbol| unsafe { (xlib.XKeysymToKeycode)(display, *symbol as _) })
            .filter(|code| *code != 0)
            .collect()
    };
    // KDE often reports the Windows key as Meta.
    let modifiers = [
        codes(&[keysym::XK_Super_L, keysym::XK_Super_R, keysym::XK_Meta_L, keysym::XK_Meta_R]),
        codes(&[keysym::XK_Control_L, keysym::XK_Control_R]),
    ];
    let v = codes(&[keysym::XK_v]);
    let state = app.state::<DropboxState>();
    state.hotkeys.store(true, Ordering::SeqCst);
    let (mut was_held, mut was_v) = (false, false);
    loop {
        let enabled = state.settings.lock().unwrap().enabled;
        let mut keys = [0 as std::ffi::c_char; 32];
        if enabled {
            unsafe { (xlib.XQueryKeymap)(display, keys.as_mut_ptr()) };
        }
        let down = |code: &u8| (keys[*code as usize / 8] as u8) & (1 << (code % 8)) != 0;
        let held = enabled && modifiers.iter().all(|group| group.iter().any(down));
        if held != was_held {
            was_held = held;
            state.held.store(held, Ordering::SeqCst);
            show_state(&app);
        }
        let v_down = held && v.iter().any(down);
        if v_down && !was_v {
            save_clipboard_soon(&app);
        }
        was_v = v_down;
        std::thread::sleep(Duration::from_millis(if enabled { 25 } else { 250 }));
    }
}

#[tauri::command]
pub fn dropbox_status(app: AppHandle) -> DropboxStatus {
    DropboxStatus {
        settings: settings(&app),
        hotkeys: app.state::<DropboxState>().hotkeys.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn dropbox_configure(app: AppHandle, settings: DropboxSettings) -> Result<DropboxStatus, String> {
    update(&app, |current| *current = settings)?;
    Ok(dropbox_status(app))
}

#[tauri::command]
pub fn dropbox_set(app: AppHandle, enabled: Option<bool>, pinned: Option<bool>, store_id: Option<String>) -> Result<(), String> {
    update(&app, |settings| {
        if let Some(enabled) = enabled {
            settings.enabled = enabled;
        }
        if let Some(pinned) = pinned {
            settings.pinned = pinned;
        }
        if let Some(store_id) = store_id {
            settings.store_id = store_id;
        }
    })
    .map(|_| ())
}

#[tauri::command]
pub fn dropbox_overlay_state(app: AppHandle) -> OverlayState {
    overlay_state(&app)
}

#[tauri::command]
pub fn dropbox_save_clipboard(app: AppHandle) {
    save_clipboard_soon(&app);
}

/// Reading the clipboard waits for the main thread, so it never runs on it.
pub fn save_clipboard_soon(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || save_clipboard(&app));
}

#[tauri::command]
pub fn dropbox_open_settings(app: AppHandle) {
    open_settings(&app);
}

fn target(app: &AppHandle) -> Result<Store, String> {
    let id = settings(app).store_id;
    if id.is_empty() {
        return Err("Choose a store for the drop box in Inpaint's settings.".into());
    }
    stores::find_store(&id).map_err(|_| "The drop box's store no longer exists. Choose another in Inpaint's settings.".into())
}

fn process(app: &AppHandle, items: Vec<Item>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DropboxState>();
        state.busy.fetch_add(1, Ordering::SeqCst);
        show_state(&app);
        let (mut results, store_name) = match target(&app) {
            Ok(store) => {
                let mut results = Vec::new();
                for item in items {
                    save_item(&store, item, &mut results);
                }
                for result in &results {
                    if let Ok(Outcome::Saved(Some(image))) = result {
                        let _ = app.emit_to("main", "store-added", serde_json::json!({ "storeId": store.id, "image": image }));
                    }
                }
                (results, store.name)
            }
            Err(error) => (vec![Err(error)], String::new()),
        };
        if results.is_empty() {
            results.push(Err("Nothing to save: no picture, file or link came with it.".into()));
        }
        send_report(&app, summarize(&results, &store_name));
        state.busy.fetch_sub(1, Ordering::SeqCst);
        show_state(&app);
    });
}

fn summarize(results: &[Result<Outcome, String>], store: &str) -> DropReport {
    let saved = results.iter().filter(|result| matches!(result, Ok(Outcome::Saved(_)))).count();
    let duplicates = results.iter().filter(|result| matches!(result, Ok(Outcome::Duplicate))).count();
    let failure = results.iter().find_map(|result| result.as_ref().err());
    let mut parts = Vec::new();
    match saved {
        0 => {}
        1 => parts.push(format!("Saved to {store}")),
        count => parts.push(format!("Saved {count} to {store}")),
    }
    match duplicates {
        0 => {}
        1 => parts.push("Already in the store".to_string()),
        count => parts.push(format!("{count} already in the store")),
    }
    parts.extend(failure.cloned());
    let outcome = if failure.is_some() { "failed" } else if saved > 0 { "saved" } else { "duplicate" };
    DropReport { outcome, message: parts.join(" · ") }
}

fn drop_items(drop: DropData) -> Vec<Item> {
    let page_images = images_in_html(&drop.html);
    let mut items = Vec::new();
    for uri in drop.uris.iter().map(|uri| uri.trim()).filter(|uri| !uri.is_empty() && !uri.starts_with('#')) {
        if uri.starts_with("file:") {
            if let Some(path) = url::Url::parse(uri).ok().and_then(|url| url.to_file_path().ok()) {
                items.push(Item::File(path));
            }
        } else if let Some(name) = uri.strip_prefix("desktop:/") {
            // Plasma's desktop sometimes names its files this way.
            items.push(Item::File(desktop_folder().join(percent_encoding::percent_decode_str(name).decode_utf8_lossy().as_ref())));
        } else {
            items.push(Item::Url { url: uri.to_string(), page_images: page_images.clone() });
        }
    }
    if items.is_empty() {
        if !drop.html.trim().is_empty() {
            items.push(Item::Text { text: drop.html, html: true });
        } else if !drop.text.trim().is_empty() {
            items.push(Item::Text { text: drop.text, html: false });
        }
    }
    items
}

fn desktop_folder() -> PathBuf {
    gtk::glib::user_special_dir(gtk::glib::UserDirectory::Desktop)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Desktop"))
}

fn save_item(store: &Store, item: Item, results: &mut Vec<Result<Outcome, String>>) {
    match item {
        Item::File(path) => results.push(save_local_file(store, &path)),
        Item::Url { url, page_images } => results.push(save_url(store, &url, &page_images, 0)),
        Item::Bytes { data, name, mime } => {
            results.push(stage_bytes(store, &data, &name, &mime).and_then(|staged| store_file(store, staged)))
        }
        Item::Text { text, html } => {
            for url in urls_in_text(&text, html) {
                results.push(save_url(store, &url, &[], 0));
            }
        }
    }
}

fn save_local_file(store: &Store, path: &Path) -> Result<Outcome, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    let extension = extension_for(&read_head(path), "", &path.to_string_lossy(), true);
    store_file(store, Staged { path: path.to_path_buf(), temp: None, extension, modified: metadata.modified().unwrap_or_else(|_| SystemTime::now()) })
}

fn save_url(store: &Store, url: &str, page_images: &[String], depth: u8) -> Result<Outcome, String> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (data, mime) = decode_data_url(rest)?;
        return stage_bytes(store, &data, "", &mime).and_then(|staged| store_file(store, staged));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("Cannot save {} links.", url.split(':').next().unwrap_or(url)));
    }
    let (staged, content_type) = download(store, url)?;
    if content_type.starts_with("text/html") {
        // A link to a page, such as a picture wrapped in a link: save the picture it shows.
        let mut html = Vec::new();
        let _ = fs::File::open(&staged.path).and_then(|file| file.take(4 << 20).read_to_end(&mut html));
        let page = String::from_utf8_lossy(&html);
        return match page_images.first().cloned().or_else(|| image_in_page(url, &page)) {
            Some(image) if depth == 0 => save_url(store, &image, &[], 1),
            _ => Err(format!("{url} is a page without a picture.")),
        };
    }
    store_file(store, staged)
}

/// Temporary files sit in the store folder, so saving is a rename; Immich uploads use the temp dir.
fn temp_file(store: &Store) -> Result<tempfile::TempPath, String> {
    let folder = if store.immich { std::env::temp_dir() } else { PathBuf::from(&store.path) };
    tempfile::Builder::new()
        .prefix(".inpaint-drop-")
        .tempfile_in(&folder)
        .map(|file| file.into_temp_path())
        .map_err(|error| format!("Cannot write to {}: {error}", folder.display()))
}

fn stage_bytes(store: &Store, data: &[u8], name: &str, mime: &str) -> Result<Staged, String> {
    let temp = temp_file(store)?;
    fs::write(&temp, data).map_err(|error| format!("Cannot save the dropped data: {error}"))?;
    let extension = extension_for(&data[..data.len().min(64)], mime, name, true);
    Ok(Staged { path: temp.to_path_buf(), temp: Some(temp), extension, modified: SystemTime::now() })
}

fn download(store: &Store, url: &str) -> Result<(Staged, String), String> {
    let temp = temp_file(store)?;
    let mut file = fs::File::create(&temp).map_err(|error| format!("Cannot save the download: {error}"))?;
    let content_type = super::http::download_to(url, "image/avif,image/webp,image/*,*/*;q=0.8", Duration::from_secs(600), 4 << 30, &mut file)?;
    drop(file);
    let name = url::Url::parse(url)
        .ok()
        .and_then(|url| url.path_segments()?.next_back().map(|segment| percent_encoding::percent_decode_str(segment).decode_utf8_lossy().into_owned()))
        .unwrap_or_default();
    let extension = extension_for(&read_head(&temp), &content_type, &name, false);
    Ok((Staged { path: temp.to_path_buf(), temp: Some(temp), extension, modified: SystemTime::now() }, content_type))
}

fn store_file(store: &Store, staged: Staged) -> Result<Outcome, String> {
    if !PICTURE_EXTENSIONS.contains(&staged.extension.as_str()) {
        return Err(format!("Only pictures can be saved, not .{} files.", staged.extension));
    }
    let sha1 = sha1_file(&staged.path)?;
    let name = format!("{sha1}.{}", staged.extension);
    if store.immich {
        return upload_to_immich(store, &staged, &sha1, &name);
    }
    let folder = Path::new(&store.path).join(&sha1[..2]).join(&sha1[2..4]);
    if contains_hash(&folder, &sha1) {
        return Ok(Outcome::Duplicate);
    }
    let destination = folder.join(&name);
    let failed = |error: &dyn Display| format!("Cannot save {}: {error}", destination.display());
    fs::create_dir_all(&folder).map_err(|error| failed(&error))?;
    let temp = match staged.temp {
        Some(temp) => temp,
        None => {
            let mut copy = tempfile::Builder::new().prefix(".inpaint-drop-").tempfile_in(&folder).map_err(|error| failed(&error))?;
            let mut source = fs::File::open(&staged.path).map_err(|error| failed(&error))?;
            io::copy(&mut source, &mut copy).map_err(|error| failed(&error))?;
            copy.into_temp_path()
        }
    };
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o644)).map_err(|error| failed(&error))?;
    match temp.persist_noclobber(&destination) {
        Ok(()) => {}
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => return Ok(Outcome::Duplicate),
        // Network shares may not support renaming without overwriting; the hash was checked above.
        Err(error) => error.path.persist(&destination).map_err(|error| failed(&error.error))?,
    }
    stores::record_picture(&destination);
    Ok(Outcome::Saved(super::image_entry(&destination)))
}

fn upload_to_immich(store: &Store, staged: &Staged, sha1: &str, name: &str) -> Result<Outcome, String> {
    let data = fs::read(&staged.path).map_err(|error| format!("Cannot read {}: {error}", staged.path.display()))?;
    Ok(match immich::upload(&data, name, sha1, staged.modified)? {
        immich::Upload::Duplicate => Outcome::Duplicate,
        immich::Upload::Created(id) => Outcome::Saved(immich::local_path(store, &id).and_then(|path| {
            stores::record_picture(&path);
            super::image_entry(&path)
        })),
    })
}

fn sha1_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let mut hasher = sha1_smol::Sha1::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.digest().to_string())
}

/// Whether a file named after this hash, with any extension, is in the folder.
fn contains_hash(folder: &Path, sha1: &str) -> bool {
    fs::read_dir(folder)
        .map(|entries| entries.flatten().any(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase().split('.').next() == Some(sha1)))
        .unwrap_or(false)
}

fn read_head(path: &Path) -> Vec<u8> {
    let mut head = Vec::with_capacity(64);
    let _ = fs::File::open(path).and_then(|file| file.take(64).read_to_end(&mut head));
    head
}

fn clean_extension(extension: &str) -> Option<String> {
    let extension = extension.to_ascii_lowercase();
    (!extension.is_empty() && extension.len() <= 10 && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())).then_some(extension)
}

fn mime_extension(mime: &str) -> Option<String> {
    let extension = match mime.split(';').next().unwrap_or_default().trim() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/bmp" => "bmp",
        "image/tiff" => "tif",
        _ => return None,
    };
    Some(extension.into())
}

/// Local and dropped files keep the extension of their name; downloads trust their content first.
fn extension_for(head: &[u8], mime: &str, name: &str, name_first: bool) -> String {
    let from_name = || Path::new(name).extension().and_then(|extension| clean_extension(&extension.to_string_lossy()));
    let from_content = || image::guess_format(head).ok().and_then(|format| format.extensions_str().first().map(|extension| extension.to_string()));
    let found = if name_first {
        from_name().or_else(|| mime_extension(mime)).or_else(from_content)
    } else {
        from_content().or_else(|| mime_extension(mime)).or_else(from_name)
    };
    found.unwrap_or_else(|| "bin".into())
}

fn decode_data_url(rest: &str) -> Result<(Vec<u8>, String), String> {
    let (meta, payload) = rest.split_once(',').ok_or("The data link is incomplete.")?;
    let mime = meta.split(';').next().unwrap_or_default().to_string();
    let data = if meta.ends_with(";base64") {
        let compact: String = payload.chars().filter(|character| !character.is_whitespace()).collect();
        BASE64.decode(percent_encoding::percent_decode_str(&compact).collect::<Vec<u8>>()).map_err(|error| format!("The data link is not valid base64: {error}"))?
    } else {
        percent_encoding::percent_decode_str(payload).collect()
    };
    Ok((data, mime))
}

/// The text inside every `<name …>` tag.
fn tags(html: &str, name: &str) -> Vec<String> {
    // ASCII lowercasing keeps byte offsets, so they index both strings.
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(start) = lower[from..].find(&open).map(|index| from + index) {
        let after = start + open.len();
        let Some(end) = lower[after..].find('>').map(|index| after + index) else { break };
        if lower[after..].starts_with(|character: char| character.is_ascii_whitespace() || character == '/') {
            found.push(html[after..end].to_string());
        }
        from = end;
    }
    found
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(index) = lower[from..].find(name).map(|found| from + found) {
        from = index + name.len();
        let rest = lower[from..].trim_start();
        if !(index == 0 || lower.as_bytes()[index - 1].is_ascii_whitespace()) || !rest.starts_with('=') {
            continue;
        }
        let value = tag[tag.len() - rest.len() + 1..].trim_start();
        let (body, end) = match value.chars().next() {
            Some(quote @ ('"' | '\'')) => (&value[1..], value[1..].find(quote)?),
            _ => (value, value.find(|character: char| character.is_ascii_whitespace()).unwrap_or(value.len())),
        };
        return Some(body[..end].replace("&amp;", "&"));
    }
    None
}

fn images_in_html(html: &str) -> Vec<String> {
    let mut sources: Vec<String> = Vec::new();
    for source in tags(html, "img").iter().filter_map(|tag| attribute(tag, "src")) {
        if (source.starts_with("http://") || source.starts_with("https://") || source.starts_with("data:")) && !sources.contains(&source) {
            sources.push(source);
        }
    }
    sources
}

/// The picture a web page shows: its og:image, or else its first image.
fn image_in_page(base: &str, html: &str) -> Option<String> {
    let shared = tags(html, "meta").iter().find_map(|tag| {
        let key = attribute(tag, "property").or_else(|| attribute(tag, "name"))?.to_ascii_lowercase();
        matches!(key.as_str(), "og:image" | "og:image:url" | "og:image:secure_url" | "twitter:image").then(|| attribute(tag, "content")).flatten()
    });
    let source = shared.or_else(|| tags(html, "img").iter().find_map(|tag| attribute(tag, "src")))?;
    url::Url::parse(base).ok()?.join(&source).ok().map(String::from)
}

fn urls_in_text(text: &str, html: bool) -> Vec<String> {
    let mut urls = if html { images_in_html(text) } else { Vec::new() };
    if urls.is_empty() {
        for token in text.split(|character: char| character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>')) {
            let token = token.trim_start_matches(['(', '[']).trim_end_matches([',', '.', ')', ']', ';']).replace("&amp;", "&");
            let linked = token.starts_with("http://") || token.starts_with("https://") || token.starts_with("data:");
            if linked && token.len() > 8 && !urls.contains(&token) {
                urls.push(token);
            }
        }
    }
    urls
}

fn save_clipboard(app: &AppHandle) {
    match read_clipboard(app) {
        Ok(items) => process(app, items),
        Err(message) => {
            send_report(app, DropReport { outcome: "failed", message });
        }
    }
}

/// Copied files, then a picture, then links in HTML or text. GTK needs the main thread.
fn read_clipboard(app: &AppHandle) -> Result<Vec<Item>, String> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        use gtk::gdk::{Atom, SELECTION_CLIPBOARD};
        let clipboard = gtk::Clipboard::get(&SELECTION_CLIPBOARD);
        let contents = |target: &str| clipboard.wait_for_contents(&Atom::intern(target)).map(|data| data.data()).filter(|data| !data.is_empty());
        let uris: Vec<String> = clipboard.wait_for_uris().into_iter().map(String::from).collect();
        let items = if !uris.is_empty() {
            drop_items(DropData { uris, ..Default::default() })
        } else if let Some(png) = contents("image/png").or_else(|| clipboard.wait_for_image().and_then(|image| image.save_to_bufferv("png", &[]).ok())) {
            vec![Item::Bytes { data: png, name: "clipboard.png".into(), mime: "image/png".into() }]
        } else if let Some(html) = contents("text/html") {
            vec![Item::Text { text: clipboard_text(&html), html: true }]
        } else if let Some(text) = clipboard.wait_for_text() {
            vec![Item::Text { text: text.into(), html: false }]
        } else {
            Vec::new()
        };
        let _ = sender.send(items);
    })
    .map_err(|error| error.to_string())?;
    receiver.recv_timeout(Duration::from_secs(15)).map_err(|_| "The clipboard did not answer.".to_string())
}

/// Firefox offers text/html as UTF-16.
fn clipboard_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.get(1) == Some(&0) {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        String::from_utf16_lossy(&units).trim_start_matches('\u{feff}').to_string()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder_store(root: &Path) -> Store {
        Store { id: "test".into(), name: "Test".into(), path: super::super::path_string(root), immich: false, immich_path: String::new() }
    }

    #[test]
    fn extensions_prefer_names_for_files_and_content_for_downloads() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(extension_for(png, "", "/tmp/Photo.JPEG", true), "jpeg");
        assert_eq!(extension_for(png, "image/jpeg", "image.php", false), "png");
        assert_eq!(extension_for(b"....", "image/jpeg", "media", false), "jpg");
        assert_eq!(extension_for(b"....", "application/octet-stream", "clip.MP4", false), "mp4");
        assert_eq!(extension_for(b"....", "", "no extension", true), "bin");
        assert_eq!(extension_for(b"....", "", "weird.ex t", true), "bin");
    }

    #[test]
    fn files_are_stored_by_hash_once() {
        let root = tempfile::tempdir().unwrap();
        let store = folder_store(root.path());
        let source = root.path().join("source.JPG");
        fs::write(&source, b"picture bytes").unwrap();
        let sha1 = sha1_smol::Sha1::from(b"picture bytes").digest().to_string();
        assert!(matches!(save_local_file(&store, &source), Ok(Outcome::Saved(_))));
        let saved = root.path().join(&sha1[..2]).join(&sha1[2..4]).join(format!("{sha1}.jpg"));
        assert_eq!(fs::read(&saved).unwrap(), b"picture bytes");
        assert_eq!(fs::metadata(&saved).unwrap().permissions().mode() & 0o777, 0o644);
        // Same content under another name or extension, or as bytes, is a duplicate.
        let copy = root.path().join("copy.png");
        fs::copy(&source, &copy).unwrap();
        assert!(matches!(save_local_file(&store, &copy), Ok(Outcome::Duplicate)));
        let staged = stage_bytes(&store, b"picture bytes", "drop.webp", "image/webp").unwrap();
        assert!(matches!(store_file(&store, staged), Ok(Outcome::Duplicate)));
        let staged = stage_bytes(&store, b"other bytes", "notes.txt", "text/plain").unwrap();
        assert!(matches!(store_file(&store, staged), Err(message) if message.contains(".txt")));
        let staged = stage_bytes(&store, b"other bytes", "photo.heic", "").unwrap();
        assert!(matches!(store_file(&store, staged), Ok(Outcome::Saved(None))));
        let leftovers = fs::read_dir(root.path()).unwrap().flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with(".inpaint-drop-")).count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn saved_pictures_are_reported_for_the_gallery() {
        let root = tempfile::tempdir().unwrap();
        let store = folder_store(root.path());
        let png = image::DynamicImage::new_rgb8(2, 2);
        let bytes = super::super::encode_image(&png, image::ImageFormat::Png).unwrap();
        let staged = stage_bytes(&store, &bytes, "", "").unwrap();
        let Ok(Outcome::Saved(Some(entry))) = store_file(&store, staged) else { panic!("expected a picture entry") };
        assert_eq!(entry.extension, "png");
        assert!(entry.name.len() == 44 && entry.path.starts_with(&store.path));
    }

    #[test]
    fn pages_and_html_yield_their_pictures() {
        let page = r#"<html><head><meta content="/og.jpg?a=1&amp;b=2" property="og:image"><meta name="og:image:width" content="10"></head><body><img src="first.png"></body>"#;
        assert_eq!(image_in_page("https://example.com/post/1", page).as_deref(), Some("https://example.com/og.jpg?a=1&b=2"));
        assert_eq!(image_in_page("https://example.com/a/b", "<IMG alt='x' SRC='pic.webp'>").as_deref(), Some("https://example.com/a/pic.webp"));
        assert_eq!(image_in_page("https://example.com/", "<p>no pictures</p>"), None);
        let dragged = r#"<meta charset="utf-8"><img srcset="x 2x" src="https://cdn.example.com/p.jpg" data-src="nope">"#;
        assert_eq!(images_in_html(dragged), ["https://cdn.example.com/p.jpg"]);
        assert_eq!(urls_in_text("see https://a.example/x.png, and (https://b.example/y).", false), ["https://a.example/x.png", "https://b.example/y"]);
        assert_eq!(urls_in_text("<a href=\"https://c.example/?q=1&amp;r=2\">link</a>", true), ["https://c.example/?q=1&r=2"]);
        assert!(urls_in_text("plain words only", false).is_empty());
    }

    #[test]
    fn drops_and_data_links_are_understood() {
        let items = drop_items(DropData { uris: vec!["# comment".into(), "file:///tmp/a%20b.jpg".into(), "https://example.com/p.png".into()], ..Default::default() });
        assert!(matches!(&items[0], Item::File(path) if path == Path::new("/tmp/a b.jpg")));
        assert!(matches!(&items[1], Item::Url { url, .. } if url == "https://example.com/p.png"));
        let items = drop_items(DropData { text: "https://example.com/only-text".into(), ..Default::default() });
        assert!(matches!(&items[0], Item::Text { html: false, .. }));
        assert!(drop_items(DropData::default()).is_empty());
        assert_eq!(decode_data_url("image/png;base64,aGVs bG8=").unwrap(), (b"hello".to_vec(), "image/png".to_string()));
        assert_eq!(decode_data_url("text/plain,a%20b").unwrap(), (b"a b".to_vec(), "text/plain".to_string()));
        assert_eq!(clipboard_text(&[0xff, 0xfe, b'h', 0, b'i', 0]), "hi");
    }

    #[test]
    fn window_opacity_follows_the_state() {
        assert_eq!(target_opacity(false, 0.4, true), 0.0);
        assert_eq!(target_opacity(true, 0.4, false), 0.4);
        assert_eq!(target_opacity(true, 0.4, true), 0.9);
        assert_eq!(target_opacity(true, 0.95, true), 0.95);
    }

    #[test]
    fn native_drops_prefer_the_picture_itself() {
        let offered = |targets: &[&str]| targets.iter().map(|target| target.to_string()).collect::<Vec<_>>();
        // Chromium dragging a picture: its bytes, not the link.
        let mut drop = NativeDrop::new(offered(&["text/uri-list", "text/html", "application/octet-stream", "_NETSCAPE_URL", "chromium/x-renderer-taint"]));
        assert_eq!(drop.next_target().as_deref(), Some("application/octet-stream"));
        let bytes = selection_items("application/octet-stream", b"\x89PNG\r\n\x1a\n");
        assert!(matches!(drop.accept(bytes), Next::Done(items) if matches!(items[..], [Item::Bytes { .. }])));

        // Only a link at first: it is kept while an offered picture is tried, then used.
        let mut drop = NativeDrop::new(offered(&["image/png", "text/uri-list", "text/plain"]));
        assert_eq!(drop.next_target().as_deref(), Some("text/uri-list"));
        let links = selection_items("text/uri-list", b"https://example.com/p.jpg\r\n");
        assert!(matches!(drop.accept(links), Next::Request(target) if target == "image/png"));
        assert!(matches!(drop.accept(Vec::new()), Next::Done(items) if matches!(&items[..], [Item::Url { url, .. }] if url == "https://example.com/p.jpg")));

        // Files from a file manager or the desktop.
        let mut drop = NativeDrop::new(offered(&["text/uri-list", "text/plain"]));
        drop.next_target();
        let files = selection_items("text/uri-list", b"file:///home/sy/Desktop/a%20b.png\r\n");
        assert!(matches!(drop.accept(files), Next::Done(items) if matches!(&items[..], [Item::File(path)] if path == Path::new("/home/sy/Desktop/a b.png"))));

        // Text without links moves on; with nothing usable the report lists what was offered.
        let mut drop = NativeDrop::new(offered(&["text/plain", "application/x-kde4-urilist"]));
        drop.next_target();
        assert!(matches!(drop.accept(selection_items("text/plain", b"just words")), Next::Nothing));
        assert!(nothing_offered(&drop.offered).message.contains("application/x-kde4-urilist"));
        let moz_url: Vec<u8> = "http://x.io\nTitle".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert!(matches!(&selection_items("text/x-moz-url", &moz_url)[..], [Item::Url { url, .. }] if url == "http://x.io"));
        assert!(matches!(&selection_items("text/html", b"<img src=\"https://cdn.example.com/p.webp\">")[..], [Item::Url { url, .. }] if url == "https://cdn.example.com/p.webp"));
    }

    #[test]
    fn settings_are_checked() {
        assert!(validated(DropboxSettings::default()).is_ok());
        assert!(validated(DropboxSettings { width: 10, ..Default::default() }).is_err());
        assert!(validated(DropboxSettings { opacity: 1.5, ..Default::default() }).is_err());
        assert!(validated(DropboxSettings { margin: 5000, ..Default::default() }).is_err());
        assert_eq!(validated(DropboxSettings { monitor: "top".into(), ..Default::default() }).unwrap().monitor, "middle");
    }
}
