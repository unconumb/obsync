// Pure DOM-building functions for the 280px dropdown (UI Design Contract,
// D-08 layout: status block -> six-count table -> conditional AI line ->
// separator -> actions). Each function returns a new element tree — no
// mutation of shared state, callers replace #app's children wholesale.

import { formatRelativeTime } from "./relative-time";
import type { StatusFile } from "./status-types";

export interface ActionHandlers {
  onSyncNow: () => void;
  onOpenDashboard: () => void;
  onQuit: () => void;
}

export interface RenderOptions {
  /** True while a Sync Now invocation is in flight (D-09 optimistic UI). */
  syncing: boolean;
}

/**
 * Render the "Not running" empty state (D-05): informational only, no
 * Sync Now / start action. Open Dashboard is still offered if a vault path
 * is already known from a stale status snapshot.
 */
export function renderNotRunning(status: StatusFile | null, handlers: ActionHandlers): HTMLElement {
  const app = document.createElement("div");

  const statusBlock = document.createElement("div");
  statusBlock.className = "status-block";

  const heading = document.createElement("p");
  heading.className = "empty-state-heading";
  heading.textContent = "Not running";
  statusBlock.appendChild(heading);

  const body = document.createElement("p");
  body.className = "empty-state-body";
  body.innerHTML =
    "<code>obsync watch</code> is not running. Start it from a terminal with <code>obsync install-service</code>.";
  statusBlock.appendChild(body);

  app.appendChild(statusBlock);

  // Always append the separator + actions block (Quit must always be
  // reachable, even with no vault path known yet).
  app.appendChild(buildSeparator());
  app.appendChild(buildActions({ showSyncNow: false, syncing: false }, handlers));

  return app;
}

/**
 * Render the running view: status block (Last Sync or error line), six-count
 * table, conditional AI line, separator, then Sync Now + Open Dashboard.
 */
export function renderRunning(status: StatusFile, options: RenderOptions, handlers: ActionHandlers): HTMLElement {
  const app = document.createElement("div");

  const statusBlock = document.createElement("div");
  statusBlock.className = "status-block";
  statusBlock.appendChild(buildStatusLine(status));
  statusBlock.appendChild(buildCountsTable(status.sync.counts));

  const aiLine = buildAiLine(status);
  if (aiLine) {
    statusBlock.appendChild(aiLine);
  }

  app.appendChild(statusBlock);
  app.appendChild(buildSeparator());
  app.appendChild(buildActions({ showSyncNow: true, syncing: options.syncing }, handlers));

  return app;
}

/**
 * Status block line 1 (D-08): "Last Sync: {relative time}", or — when
 * sync.state === 'error' — the destructive "Last sync failed — {N} error(s)"
 * line with a "View details" link that opens the dashboard.
 */
function buildStatusLine(status: StatusFile): HTMLElement {
  const line = document.createElement("p");
  line.className = "status-line";

  if (status.sync.state === "error") {
    line.classList.add("error");
    const errorCount = status.sync.counts.errors;
    const noun = errorCount === 1 ? "error" : "errors";
    line.textContent = `Last sync failed — ${errorCount} ${noun}`;

    const link = document.createElement("a");
    link.className = "view-details";
    link.textContent = "View details";
    link.dataset.action = "view-details";
    line.appendChild(document.createTextNode(" "));
    line.appendChild(link);
    return line;
  }

  const relative = status.sync.lastSyncAt ? formatRelativeTime(status.sync.lastSyncAt) : "never";
  line.textContent = `Last Sync: ${relative}`;
  return line;
}

/** Six-count table: Added / Updated / Moved / Removed / Unchanged / Errors. */
function buildCountsTable(counts: StatusFile["sync"]["counts"]): HTMLElement {
  const table = document.createElement("div");
  table.className = "counts-table";

  const rows: Array<[string, number]> = [
    ["Added", counts.added],
    ["Updated", counts.updated],
    ["Moved", counts.moved],
    ["Removed", counts.removed],
    ["Unchanged", counts.unchanged],
    ["Errors", counts.errors],
  ];

  for (const [label, value] of rows) {
    const labelEl = document.createElement("span");
    labelEl.className = "count-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = "count-value";
    valueEl.textContent = String(value);

    table.appendChild(labelEl);
    table.appendChild(valueEl);
  }

  return table;
}

/**
 * Conditional "Summarizing... (N queued)" line — shown ONLY when
 * ai.queueDepth > 0 AND sync.state === 'syncing'. Returns null (hidden,
 * no "0 queued" noise) otherwise.
 */
function buildAiLine(status: StatusFile): HTMLElement | null {
  if (status.ai.queueDepth <= 0 || status.sync.state !== "syncing") {
    return null;
  }

  const line = document.createElement("p");
  line.className = "ai-line";
  line.textContent = `Summarizing... (${status.ai.queueDepth} queued)`;
  return line;
}

function buildSeparator(): HTMLElement {
  const hr = document.createElement("hr");
  hr.className = "separator";
  return hr;
}

interface ActionsOptions {
  showSyncNow: boolean;
  syncing: boolean;
}

/** Actions row: "Sync Now" (D-09 optimistic disable) then "Open Dashboard". */
function buildActions(options: ActionsOptions, handlers: ActionHandlers): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "actions";

  if (options.showSyncNow) {
    const syncButton = document.createElement("button");
    syncButton.type = "button";
    syncButton.className = "action-row";
    if (options.syncing) {
      syncButton.classList.add("syncing");
      syncButton.textContent = "Syncing...";
      syncButton.disabled = true;
    } else {
      syncButton.textContent = "Sync Now";
    }
    syncButton.addEventListener("click", handlers.onSyncNow);
    actions.appendChild(syncButton);
  }

  const dashboardButton = document.createElement("button");
  dashboardButton.type = "button";
  dashboardButton.className = "action-row";
  dashboardButton.textContent = "Open Dashboard";
  dashboardButton.addEventListener("click", handlers.onOpenDashboard);
  actions.appendChild(dashboardButton);

  const quitButton = document.createElement("button");
  quitButton.type = "button";
  quitButton.className = "action-row quit";
  quitButton.textContent = "Quit Obsync";
  quitButton.addEventListener("click", handlers.onQuit);
  actions.appendChild(quitButton);

  return actions;
}
