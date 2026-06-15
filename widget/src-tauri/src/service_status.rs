//! `launchctl print` wrapper mirroring `src/service/launchctl.ts`'s
//! `getServiceStatus` exactly (WIDGET-01, D-05).
//!
//! `ServiceStatus` is the ONLY deterministic channel by which the frontend
//! learns whether the launchd service (`com.obsync.watch`) is running. It
//! serializes to JS as a kebab-case string discriminant
//! (`"running"` | `"loaded-not-running"` | `"not-loaded"`) and is delivered
//! both on every `status-updated` event (`StatusEvent.service_status`, see
//! `status::watcher`) and via the `get_service_status` Tauri command for
//! cold-load (registered in `main.rs`).

use serde::Serialize;

/// launchd label for the obsync watch background service (Phase 5,
/// `src/cli/commands/service.ts` LABEL constant).
const SERVICE_LABEL: &str = "com.obsync.watch";

/// 3-way classification of `launchctl print gui/<uid>/<label>`, mirroring
/// `src/service/launchctl.ts`'s `getServiceStatus` return type exactly.
///
/// Serializes to kebab-case string discriminants so the frontend can match
/// on the literal strings `"running"` / `"loaded-not-running"` /
/// `"not-loaded"` — identical to the TS function's return values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceStatus {
    Running,
    LoadedNotRunning,
    NotLoaded,
}

/// Pure classification of a `launchctl print` invocation's outcome.
///
/// Mirrors `src/service/launchctl.ts` lines 34-48 exactly:
/// - non-zero exit / spawn error -> `NotLoaded`
/// - zero exit AND stdout contains the substring `"state = running"` ->
///   `Running`
/// - zero exit without that substring -> `LoadedNotRunning`
///
/// `exit_ok` is `false` for both a non-zero exit code and a spawn error
/// (the caller collapses both cases before calling this function) — see
/// `get_service_status` below.
pub fn classify(exit_ok: bool, stdout: &str) -> ServiceStatus {
    if !exit_ok {
        return ServiceStatus::NotLoaded;
    }
    if stdout.contains("state = running") {
        ServiceStatus::Running
    } else {
        ServiceStatus::LoadedNotRunning
    }
}

/// Run `launchctl print gui/{uid}/{label}` and classify the result.
///
/// Uses an argument vector (no shell interpolation, T-10-06) — `uid` is
/// numeric and `label` is a hardcoded constant in this module.
///
/// Mirrors `getServiceStatus(label, uid, execFn)` in
/// `src/service/launchctl.ts`.
pub fn query_service_status(label: &str, uid: u32) -> ServiceStatus {
    let output = std::process::Command::new("launchctl")
        .args(["print", &format!("gui/{uid}/{label}")])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            classify(out.status.success(), &stdout)
        }
        Err(_) => ServiceStatus::NotLoaded,
    }
}

/// Convenience wrapper: queries `com.obsync.watch` for the current user.
///
/// Recomputed at every `status-updated` emit (watcher.rs/poller.rs) — never
/// cached, since the launchd state can change independently of
/// `status.json`.
pub fn current_service_status() -> ServiceStatus {
    let uid = unsafe { libc::getuid() };
    query_service_status(SERVICE_LABEL, uid)
}

/// `#[tauri::command]` exposing `current_service_status()` to the frontend
/// for cold-load (before the first `status-updated` event fires).
///
/// Tauri registers commands under their Rust function name, so this command
/// is named `get_service_status` on the JS side (`invoke('get_service_status')`)
/// — distinct from the plain `get_service_status(label, uid)` function above,
/// which takes explicit arguments and is used internally by
/// `current_service_status()`.
#[tauri::command]
pub fn get_service_status() -> ServiceStatus {
    current_service_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_running_when_exit_ok_and_state_running_present() {
        let stdout = "some preamble\n\tstate = running\nmore output";
        assert_eq!(classify(true, stdout), ServiceStatus::Running);
    }

    #[test]
    fn classify_loaded_not_running_when_exit_ok_without_state_running() {
        let stdout = "some preamble\n\tstate = waiting\nmore output";
        assert_eq!(classify(true, stdout), ServiceStatus::LoadedNotRunning);
    }

    #[test]
    fn classify_not_loaded_when_exit_not_ok() {
        // Non-zero exit -> not-loaded, regardless of stdout content.
        assert_eq!(
            classify(false, "state = running"),
            ServiceStatus::NotLoaded
        );
    }

    #[test]
    fn classify_uses_substring_check_not_exact_match() {
        // "state = running" embedded in a larger line still matches
        // (mirrors TS .includes(), not an exact-line match).
        let stdout = "\t\tstate = running (pid = 1234)\n";
        assert_eq!(classify(true, stdout), ServiceStatus::Running);
    }

    #[test]
    fn service_status_serializes_to_kebab_case_strings() {
        assert_eq!(
            serde_json::to_string(&ServiceStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&ServiceStatus::LoadedNotRunning).unwrap(),
            "\"loaded-not-running\""
        );
        assert_eq!(
            serde_json::to_string(&ServiceStatus::NotLoaded).unwrap(),
            "\"not-loaded\""
        );
    }
}
