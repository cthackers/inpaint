//! System tray icon with the API server switch, the minimize-to-tray option and Exit.
//!
//! It speaks the StatusNotifierItem protocol directly through ksni. Tauri's own Linux
//! tray goes through libappindicator, which reports no clicks, so clicking the icon
//! could not bring the window back.

use ksni::{
    menu::{CheckmarkItem, RadioGroup, RadioItem, StandardItem, SubMenu},
    Icon, MenuItem, ToolTip, TrayMethods,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TraySettings {
    minimize_to_tray: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        Self { minimize_to_tray: true }
    }
}

#[derive(Default)]
pub struct TrayState {
    minimize_to_tray: AtomicBool,
    /// Set once the icon is registered; without an icon a hidden window could not come back.
    available: AtomicBool,
    handle: Mutex<Option<Arc<ksni::Handle<InpaintTray>>>>,
}

fn save_settings(settings: &TraySettings) {
    if let Err(error) = super::db::set_setting("tray", settings) {
        eprintln!("{error}");
    }
}

/// Whether closing or minimizing the window should hide it in the tray instead.
pub fn keeps_running(app: &AppHandle) -> bool {
    let state = app.state::<TrayState>();
    state.available.load(Ordering::SeqCst) && state.minimize_to_tray.load(Ordering::SeqCst)
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // GTK maps a window that was minimized when hidden as minimized again, so clear that first.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn start(app: &AppHandle) {
    let settings: TraySettings = super::db::setting("tray").and_then(Result::ok).unwrap_or_default();
    app.state::<TrayState>().minimize_to_tray.store(settings.minimize_to_tray, Ordering::SeqCst);
    let (server_running, server_error) = super::server::summary(app);
    let dropbox = super::dropbox::tray_info(app);
    let tray = InpaintTray { app: app.clone(), minimize_to_tray: settings.minimize_to_tray, server_running, server_error, dropbox };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Sandboxes do not allow owning a D-Bus name.
        #[cfg(feature = "flatpak")]
        let spawned = tray.disable_dbus_name(true).spawn().await;
        #[cfg(not(feature = "flatpak"))]
        let spawned = tray.spawn().await;
        match spawned {
            Ok(handle) => {
                let state = app.state::<TrayState>();
                *state.handle.lock().unwrap() = Some(Arc::new(handle));
                state.available.store(true, Ordering::SeqCst);
            }
            Err(error) => eprintln!("No system tray icon, so closing the window exits: {error}"),
        }
    });
}

/// Updates the menu and tooltip after the server started or stopped, or the drop box changed.
pub fn refresh(app: &AppHandle) {
    let Some(handle) = app.state::<TrayState>().handle.lock().unwrap().clone() else {
        return;
    };
    let (running, error) = super::server::summary(app);
    let dropbox = super::dropbox::tray_info(app);
    tauri::async_runtime::spawn(async move {
        handle
            .update(|tray| {
                tray.server_running = running;
                tray.server_error = error;
                tray.dropbox = dropbox;
            })
            .await;
    });
}

/// Runs a drop box change off the tray's D-Bus task, since it may open or close a window.
fn change_dropbox(app: &AppHandle, change: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || change(&app));
}

// StatusNotifierItem pixmaps are ARGB in network byte order.
static ICONS: LazyLock<Vec<Icon>> = LazyLock::new(|| {
    let pngs: [&[u8]; 2] = [include_bytes!("../icons/32x32.png"), include_bytes!("../icons/128x128.png")];
    pngs.into_iter()
        .filter_map(|png| image::load_from_memory(png).ok())
        .map(|image| {
            let (width, height) = (image.width() as i32, image.height() as i32);
            let mut data = image.into_rgba8().into_raw();
            for pixel in data.chunks_exact_mut(4) {
                pixel.rotate_right(1);
            }
            Icon { width, height, data }
        })
        .collect()
});

pub struct InpaintTray {
    app: AppHandle,
    minimize_to_tray: bool,
    server_running: bool,
    server_error: Option<String>,
    dropbox: super::dropbox::TrayInfo,
}

impl InpaintTray {
    fn dropbox_menu(&self) -> Vec<MenuItem<Self>> {
        let mut items: Vec<MenuItem<Self>> = vec![
            CheckmarkItem {
                label: "Show drop box".into(),
                checked: self.dropbox.enabled,
                activate: Box::new(|tray: &mut Self| {
                    let enabled = !tray.dropbox.enabled;
                    change_dropbox(&tray.app, move |app| super::dropbox::set_enabled(app, enabled));
                }),
                ..Default::default()
            }
            .into(),
            CheckmarkItem {
                label: "Always visible".into(),
                checked: self.dropbox.pinned,
                enabled: self.dropbox.enabled,
                activate: Box::new(|tray: &mut Self| {
                    let pinned = !tray.dropbox.pinned;
                    change_dropbox(&tray.app, move |app| super::dropbox::set_pinned(app, pinned));
                }),
                ..Default::default()
            }
            .into(),
        ];
        if !self.dropbox.stores.is_empty() {
            items.push(MenuItem::Separator);
            items.push(StandardItem { label: "Save into".into(), enabled: false, ..Default::default() }.into());
            items.push(
                RadioGroup {
                    selected: self.dropbox.store_index,
                    select: Box::new(|tray: &mut Self, index| {
                        if let Some((id, _)) = tray.dropbox.stores.get(index).cloned() {
                            change_dropbox(&tray.app, move |app| super::dropbox::set_store(app, id));
                        }
                    }),
                    options: self.dropbox.stores.iter().map(|(_, name)| RadioItem { label: name.clone(), ..Default::default() }).collect(),
                }
                .into(),
            );
        }
        items.push(MenuItem::Separator);
        items.push(
            StandardItem {
                label: "Save clipboard now".into(),
                enabled: self.dropbox.enabled,
                activate: Box::new(|tray: &mut Self| super::dropbox::save_clipboard_soon(&tray.app)),
                ..Default::default()
            }
            .into(),
        );
        items.push(
            StandardItem {
                label: "Drop box settings…".into(),
                activate: Box::new(|tray: &mut Self| super::dropbox::open_settings(&tray.app)),
                ..Default::default()
            }
            .into(),
        );
        items
    }
}

impl ksni::Tray for InpaintTray {
    fn id(&self) -> String {
        "inpaint-desktop".into()
    }

    fn title(&self) -> String {
        "Inpaint".into()
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        ICONS.clone()
    }

    fn tool_tip(&self) -> ToolTip {
        let description = match (&self.server_error, self.server_running) {
            (Some(error), _) => error.clone(),
            (None, true) => "API server running".into(),
            (None, false) => "API server stopped".into(),
        };
        ToolTip { title: "Inpaint".into(), description, ..Default::default() }
    }

    // Plasma reports clicks on the icon, including each click of a double-click, as activation.
    fn activate(&mut self, _x: i32, _y: i32) {
        show_window(&self.app);
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        vec![
            StandardItem {
                label: if self.server_running { "Stop server" } else { "Start server" }.into(),
                activate: Box::new(|tray: &mut Self| {
                    let (app, enabled) = (tray.app.clone(), !tray.server_running);
                    tauri::async_runtime::spawn(async move { super::server::set_enabled(&app, enabled).await });
                }),
                ..Default::default()
            }
            .into(),
            CheckmarkItem {
                label: "Minimize to tray".into(),
                checked: self.minimize_to_tray,
                activate: Box::new(|tray: &mut Self| {
                    tray.minimize_to_tray = !tray.minimize_to_tray;
                    tray.app.state::<TrayState>().minimize_to_tray.store(tray.minimize_to_tray, Ordering::SeqCst);
                    save_settings(&TraySettings { minimize_to_tray: tray.minimize_to_tray });
                }),
                ..Default::default()
            }
            .into(),
            SubMenu { label: "Drop box".into(), submenu: self.dropbox_menu(), ..Default::default() }.into(),
            MenuItem::Separator,
            StandardItem {
                label: "Exit".into(),
                activate: Box::new(|tray: &mut Self| tray.app.exit(0)),
                ..Default::default()
            }
            .into(),
        ]
    }
}
