//! Tray icon 4-state machine (D-07/WIDGET-01).
//!
//! `derive_icon_state` is a pure function combining the latest `SharedStatus`
//! snapshot with the launchd `ServiceStatus` (Plan 02's
//! `current_service_status()`) into one of four icon states. `apply_icon`
//! loads the matching template PNG from `icons/` and swaps the tray icon via
//! `set_icon_with_as_template` (macOS auto-tints template images for
//! light/dark menu bars, RESEARCH.md Pattern 1).
//!
//! The tray is built in `build_tray` (called from `main.rs`'s setup hook).
//! Left-clicking the tray icon toggles the visibility of the dropdown
//! `WebviewWindow` created by Plan 03 Task 2 (`"dropdown"` window label).

use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::service_status::ServiceStatus;
use crate::status::types::StatusFile;

/// Label of the borderless dropdown `WebviewWindow` created in Plan 03 Task 2.
pub const DROPDOWN_WINDOW_LABEL: &str = "dropdown";

/// The 4 tray icon states (D-07).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconState {
    Idle,
    Syncing,
    Error,
    NotRunning,
}

impl IconState {
    /// Relative path (under `icons/`) of this state's template PNG asset.
    fn asset_path(self) -> &'static str {
        match self {
            IconState::Idle => "icons/tray-idle.png",
            IconState::Syncing => "icons/tray-syncing.png",
            IconState::Error => "icons/tray-error.png",
            IconState::NotRunning => "icons/tray-not-running.png",
        }
    }
}

/// Derive the tray icon state from the latest status snapshot and the
/// launchd service status.
///
/// Rules (D-05/D-07):
/// - `service` is `NotLoaded` or `LoadedNotRunning`, OR `status` is `None`
///   -> `NotRunning` (dimmed icon, no badge).
/// - Otherwise, match `status.sync.state`: `"syncing"` -> `Syncing`,
///   `"error"` -> `Error`, `"idle"` (or any other value) -> `Idle`.
pub fn derive_icon_state(status: Option<&StatusFile>, service: ServiceStatus) -> IconState {
    if !matches!(service, ServiceStatus::Running) {
        return IconState::NotRunning;
    }

    match status {
        None => IconState::NotRunning,
        Some(file) => match file.sync.state.as_str() {
            "syncing" => IconState::Syncing,
            "error" => IconState::Error,
            _ => IconState::Idle,
        },
    }
}

/// Resolve the on-disk path for `state`'s template PNG, preferring the
/// bundled resource directory and falling back to the source tree (dev
/// builds, where `resource_dir()` may not yet contain `icons/`).
fn icon_path(app: &AppHandle, state: IconState) -> std::path::PathBuf {
    let resource_path = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(state.asset_path()));

    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(state.asset_path());

    match resource_path {
        Some(p) if p.exists() => p,
        _ => dev_path,
    }
}

/// Load a PNG file into a `tauri::image::Image`.
///
/// Tauri 2.x's `Image` has no `from_path`/PNG-decoding constructor — only
/// `Image::new_owned(rgba_bytes, width, height)`. Decode via the `image`
/// crate (RGBA8) and hand the raw buffer to `Image::new_owned`.
fn load_png_as_image(path: &std::path::Path) -> std::io::Result<Image<'static>> {
    let img = image::open(path)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err.to_string()))?
        .into_rgba8();
    let (width, height) = img.dimensions();
    Ok(Image::new_owned(img.into_raw(), width, height))
}

/// Load the PNG asset for `state` and apply it to `tray` as a template image.
///
/// `set_icon_with_as_template` sets the icon and the template flag in one
/// call (RESEARCH.md Pattern 1), avoiding a render flicker between separate
/// `set_icon` + `set_icon_as_template` calls.
pub fn apply_icon(app: &AppHandle, tray: &TrayIcon, state: IconState) {
    let path = icon_path(app, state);

    match load_png_as_image(&path) {
        Ok(icon) => {
            if let Err(err) = tray.set_icon_with_as_template(Some(icon), true) {
                eprintln!("obsync-widget: failed to set tray icon ({path:?}): {err}");
            }
        }
        Err(err) => {
            eprintln!("obsync-widget: failed to load tray icon asset ({path:?}): {err}");
        }
    }
}

/// Build the tray icon, registering a left-click handler that toggles the
/// dropdown window's visibility.
///
/// The initial icon is the `NotRunning` state; `main.rs`'s `status-updated`
/// listener immediately recomputes and applies the correct state once the
/// first event arrives.
pub fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let initial_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(IconState::NotRunning.asset_path());
    let initial_icon = load_png_as_image(&initial_path)
        .map_err(|err| tauri::Error::Io(std::io::Error::new(err.kind(), err.to_string())))?;

    let tray = TrayIconBuilder::new()
        .icon(initial_icon)
        .icon_as_template(true)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window(DROPDOWN_WINDOW_LABEL) {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(tray)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::types::{AiSection, SourceEntry, SyncCounts, SyncSection, VaultSection};

    fn sample_status(sync_state: &str) -> StatusFile {
        StatusFile {
            sync: SyncSection {
                state: sync_state.to_string(),
                last_sync_at: None,
                counts: SyncCounts {
                    added: 0,
                    updated: 0,
                    moved: 0,
                    removed: 0,
                    unchanged: 0,
                    errors: 0,
                },
                errors: vec![],
            },
            ai: AiSection {
                backend: "none".to_string(),
                queue_depth: 0,
            },
            sources: vec![SourceEntry {
                name: "thornode".to_string(),
                pending_count: 0,
            }],
            vault: VaultSection {
                path: "~/Vault".to_string(),
            },
            config_path: None,
            pid: 1,
            port: 0,
            updated_at: "2026-06-14T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn none_status_is_not_running() {
        assert_eq!(
            derive_icon_state(None, ServiceStatus::Running),
            IconState::NotRunning
        );
    }

    #[test]
    fn not_loaded_service_is_not_running_even_with_status() {
        let status = sample_status("idle");
        assert_eq!(
            derive_icon_state(Some(&status), ServiceStatus::NotLoaded),
            IconState::NotRunning
        );
    }

    #[test]
    fn loaded_not_running_service_is_not_running_even_with_status() {
        let status = sample_status("idle");
        assert_eq!(
            derive_icon_state(Some(&status), ServiceStatus::LoadedNotRunning),
            IconState::NotRunning
        );
    }

    #[test]
    fn running_service_with_idle_sync_is_idle() {
        let status = sample_status("idle");
        assert_eq!(
            derive_icon_state(Some(&status), ServiceStatus::Running),
            IconState::Idle
        );
    }

    #[test]
    fn running_service_with_syncing_sync_is_syncing() {
        let status = sample_status("syncing");
        assert_eq!(
            derive_icon_state(Some(&status), ServiceStatus::Running),
            IconState::Syncing
        );
    }

    #[test]
    fn running_service_with_error_sync_is_error() {
        let status = sample_status("error");
        assert_eq!(
            derive_icon_state(Some(&status), ServiceStatus::Running),
            IconState::Error
        );
    }
}
