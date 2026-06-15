//! obsync menu bar widget — Tauri v2 application library.
//!
//! `run()` is called from `main.rs` (the standard Tauri v2 split between a
//! thin binary entry point and the app builder living in the library so it
//! can also be exercised by mobile targets/tests).
//!
//! On `setup`, this registers `SharedStatus` as managed state, starts the
//! `~/.obsync/` file watcher (D-01), starts the `/status` polling loop
//! (D-02), spawns a cold-start `obsync status --json` snapshot (D-03), and
//! registers the `get_service_status` command (D-05) for frontend cold-load.
//!
//! It also builds the 4-state tray icon (Plan 03 Task 1, D-07) and listens
//! for `status-updated` events to keep the icon in sync, creates the
//! borderless dropdown `WebviewWindow`, and registers the `sync_now`/
//! `open_dashboard` commands (Plan 03 Task 2, WIDGET-03/WIDGET-04).

pub mod commands;
pub mod service_status;
pub mod status;
pub mod tray;

use tauri::{Listener, Manager};

use service_status::current_service_status;
use status::poller::start_poller;
use status::state::new_shared_status;
use status::watcher::start_watcher;
use tray::{apply_icon, build_tray, derive_icon_state};

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(new_shared_status())
        .invoke_handler(tauri::generate_handler![
            service_status::get_service_status,
            commands::sync_now,
            commands::open_dashboard,
            commands::quit_app
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<status::state::SharedStatus>().inner().clone();

            start_watcher(app_handle.clone(), state.clone());
            start_poller(app_handle.clone(), state.clone());

            tauri::async_runtime::spawn(async move {
                commands::cold_start_snapshot(&app_handle, &state).await;
            });

            // Create the borderless dropdown WebviewWindow (D-08). The tray's
            // left-click handler toggles its visibility.
            commands::build_dropdown_window(app.handle())?;

            // Build the tray icon (D-07).
            let tray = build_tray(app.handle())?;

            // Recompute and apply the icon state on every status-updated
            // event, using the latest SharedStatus snapshot and the
            // Rust-side current_service_status() (not the event's
            // serviceStatus field, which is for the frontend per Task 2).
            let listener_app = app.handle().clone();
            let listener_state = app.state::<status::state::SharedStatus>().inner().clone();
            app.listen(status::STATUS_UPDATED_EVENT, move |_event| {
                let status_guard = listener_state.lock().expect("status mutex not poisoned");
                let icon_state = derive_icon_state(status_guard.as_ref(), current_service_status());
                drop(status_guard);
                apply_icon(&listener_app, &tray, icon_state);
            });

            // Run as a pure status-bar accessory: no Dock icon, no Cmd-Tab
            // entry (D-... WIDGET-POLISH-DOCK). The `tauri.conf.json`
            // `activationPolicy` key is NOT honored by Tauri v2 — this is
            // the correct mechanism.
            app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running obsync widget");
}
