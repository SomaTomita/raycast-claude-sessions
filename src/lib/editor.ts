import { existsSync } from "node:fs";

import { runAppleScript } from "@raycast/utils";

import { appleQuote } from "./quote";
import { run } from "./run";

/** Editors offered in preferences. Any other app name still works through `open -a`. */
export type EditorApp = "Zed" | "Visual Studio Code";

/** CLI entry points, in preference order. The bundled CLI is the fallback when PATH is unhelpful. */
const EDITOR_CLIS: Record<string, readonly string[]> = {
  Zed: ["/opt/homebrew/bin/zed", "/usr/local/bin/zed", "/Applications/Zed.app/Contents/MacOS/cli"],
  "Visual Studio Code": [
    "/opt/homebrew/bin/code",
    "/usr/local/bin/code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  ],
  Cursor: ["/opt/homebrew/bin/cursor", "/usr/local/bin/cursor"],
};

/**
 * Flag that forces a brand new window.
 * Without it, `zed <dir>` can swap the project of the focused window, which closes that
 * window's terminal tabs and kills every Claude session running in them.
 */
const NEW_WINDOW_FLAG: Record<string, string> = {
  Zed: "--new",
  "Visual Studio Code": "--new-window",
  Cursor: "--new-window",
};

/** Process name to look for when checking whether the editor is already running. */
const EDITOR_PROCESS: Record<string, string> = {
  Zed: "zed",
  "Visual Studio Code": "Code",
  Cursor: "Cursor",
};

export function resolveEditorCli(appName: string): string | null {
  return (EDITOR_CLIS[appName] ?? []).find((path) => existsSync(path)) ?? null;
}

export function editorProcessName(appName: string): string {
  return EDITOR_PROCESS[appName] ?? appName;
}

export function editorLabel(appName: string): string {
  return appName === "Visual Studio Code" ? "VS Code" : appName;
}

/** Brings the editor to the front without touching any window or project. */
export async function activateEditor(appName: string): Promise<void> {
  await runAppleScript(`tell application ${appleQuote(appName)} to activate`);
}

/**
 * Opens `cwd` in a new editor window. Existing windows, their terminals, and the
 * processes inside them are left alone.
 */
export async function openProjectInNewWindow(appName: string, cwd: string): Promise<void> {
  if (cwd.length === 0) {
    throw new Error("This session has no recorded directory");
  }
  if (!existsSync(cwd)) {
    throw new Error(`Directory no longer exists: ${cwd}`);
  }

  const cli = resolveEditorCli(appName);
  if (cli === null) {
    // `open -a` hands the path to the running instance, which may reuse a window; least-bad fallback.
    await run("/usr/bin/open", ["-a", appName, cwd]);
    return;
  }

  const flag = NEW_WINDOW_FLAG[appName];
  await run(cli, flag === undefined ? [cwd] : [flag, cwd]);
  await activateEditor(appName);
}
