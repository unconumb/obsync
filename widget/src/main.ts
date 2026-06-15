// Dropdown frontend entry point (Plan 03 Task 2, D-08 layout).
//
// Listens for the "status-updated" Tauri event (Plan 02's StatusEvent
// `{ status: StatusFile|null, serviceStatus }`) and re-renders the 280px
// dropdown. The not-running view is driven deterministically by
// `serviceStatus !== 'running'` (D-05) — never by `status === null` alone,
// since status.json can be transiently absent while the watch service is
// running. On load, `get_service_status` is invoked once to paint the
// correct initial state before the first event arrives.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { renderNotRunning, renderRunning } from "./render";
import type { ServiceStatus, StatusEvent, StatusFile, SyncNowResult } from "./status-types";

interface AppState {
  status: StatusFile | null;
  serviceStatus: ServiceStatus;
  /** True while a Sync Now invocation is in flight (D-09 optimistic UI). */
  syncPending: boolean;
}

const state: AppState = {
  status: null,
  serviceStatus: "not-loaded",
  syncPending: false,
};

function getAppRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("missing #app root element");
  }
  return root;
}

function render(): void {
  const root = getAppRoot();
  const handlers = {
    onSyncNow: handleSyncNow,
    onOpenDashboard: handleOpenDashboard,
    onQuit: handleQuit,
  };

  const isRunning = state.serviceStatus === "running" && state.status !== null;

  const next = isRunning
    ? renderRunning(state.status as StatusFile, { syncing: state.syncPending }, handlers)
    : renderNotRunning(state.status, handlers);

  root.replaceChildren(...Array.from(next.childNodes));
}

async function handleSyncNow(): Promise<void> {
  if (state.syncPending) {
    return;
  }

  // D-09: optimistically show "Syncing..." and disable the button
  // immediately, before the command resolves.
  state.syncPending = true;
  render();

  try {
    const result = await invoke<SyncNowResult>("sync_now");
    if (result.alreadySyncing) {
      // The D-10 guard refused a second spawn — the in-progress sync is
      // already reflected by sync.state === 'syncing' from status-updated,
      // so clear our optimistic flag and let the next event drive the UI.
      state.syncPending = false;
      render();
    }
    // Otherwise leave syncPending true; the next "status-updated" event
    // (sync.state transitioning away from 'syncing') will clear it via
    // applyStatusEvent below.
  } catch (error: unknown) {
    state.syncPending = false;
    logError("sync_now failed", error);
    render();
  }
}

async function handleOpenDashboard(): Promise<void> {
  try {
    await invoke("open_dashboard");
  } catch (error: unknown) {
    logError("open_dashboard failed", error);
  }
}

async function handleQuit(): Promise<void> {
  try {
    await invoke("quit_app");
  } catch (error: unknown) {
    logError("quit_app failed", error);
  }
}

function applyStatusEvent(event: StatusEvent): void {
  state.status = event.status;
  state.serviceStatus = event.serviceStatus;

  // Clear the optimistic "Syncing..." state once the backend reports a
  // non-syncing sync.state (success or error) — never inferred from
  // sync_now's own return value (D-11: status.json is the source of truth).
  if (state.syncPending && event.status?.sync.state !== "syncing") {
    state.syncPending = false;
  }

  render();
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`obsync-widget: ${message}: ${detail}`);
}

async function init(): Promise<void> {
  // Cold-load: paint the correct running/not-running state before the first
  // status-updated event arrives.
  try {
    state.serviceStatus = await invoke<ServiceStatus>("get_service_status");
  } catch (error: unknown) {
    logError("get_service_status failed", error);
  }
  render();

  await listen<StatusEvent>("status-updated", (event) => {
    applyStatusEvent(event.payload);
  });
}

void init();
