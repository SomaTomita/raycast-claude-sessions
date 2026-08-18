import { basename } from "node:path";

import { runAppleScript } from "@raycast/utils";

import { activateProcess } from "./activate";
import { appleQuote } from "./quote";

/** Zed titles windows `project — active file`; a multi-root workspace lists roots as `a, b`. */
const TITLE_SEPARATOR = " — ";
const ROOT_SEPARATOR = ", ";
/** AppleScript renders a menu separator's name as this. */
const MENU_SEPARATOR = "missing value";

/**
 * Window titles from the application's own Window menu.
 *
 * `windows of process` through the accessibility API only reports windows on the **current Space**,
 * so with one window per desktop it returns one entry out of six. The Window menu lists every
 * window regardless of Space, and clicking an entry switches to it.
 */
async function listMenuWindowTitles(processName: string): Promise<string[]> {
  const output = await runAppleScript(`tell application "System Events"
  if not (exists process ${appleQuote(processName)}) then return ""
  tell process ${appleQuote(processName)}
    try
      set theItems to menu items of menu 1 of menu bar item "Window" of menu bar 1
    on error
      return ""
    end try
    set out to ""
    repeat with mi in theItems
      set out to out & (name of mi as text) & linefeed
    end repeat
    return out
  end tell
end tell`);

  // The window list sits after the last separator; everything before it is window commands.
  const lines = output.split("\n").map((line) => line.trim());
  const lastSeparator = lines.lastIndexOf(MENU_SEPARATOR);
  return lines.slice(lastSeparator + 1).filter((line) => line.length > 0 && line !== MENU_SEPARATOR);
}

/** Fallback for applications without a Window menu: accessibility windows, current Space only. */
async function listAccessibilityWindowTitles(processName: string): Promise<string[]> {
  const output = await runAppleScript(`tell application "System Events"
  if not (exists process ${appleQuote(processName)}) then return ""
  tell process ${appleQuote(processName)}
    set out to ""
    repeat with w in windows
      set out to out & (name of w) & linefeed
    end repeat
    return out
  end tell
end tell`);
  return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function listWindowTitles(processName: string): Promise<string[]> {
  try {
    const fromMenu = await listMenuWindowTitles(processName);
    if (fromMenu.length > 0) {
      return fromMenu;
    }
  } catch {
    // fall through to the accessibility list
  }
  try {
    return await listAccessibilityWindowTitles(processName);
  } catch {
    return [];
  }
}

/** Every project root currently shown by that application's windows. */
export async function listProjectRoots(processName: string): Promise<Set<string>> {
  return new Set((await listWindowTitles(processName)).flatMap(rootsOf));
}

/** Project roots a window title claims, e.g. `migration, repro-audit — file.png` -> both names. */
function rootsOf(title: string): string[] {
  const projectPart = title.split(TITLE_SEPARATOR)[0] ?? "";
  return projectPart
    .split(ROOT_SEPARATOR)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
}

/**
 * Switches to the existing window for `cwd` and returns true.
 * Returns false when no window matches, leaving the application untouched, so the caller can
 * decide what to do instead of mutating an existing workspace.
 *
 * Matching is by folder name: window titles carry no path, so two projects sharing a basename
 * cannot be told apart. The first match wins.
 */
export async function focusProjectWindow(
  appName: string,
  processName: string,
  cwd: string,
  hostPid: number,
): Promise<boolean> {
  const target = basename(cwd);
  if (target.length === 0) {
    return false;
  }

  const titles = await listWindowTitles(processName);
  const index = titles.findIndex((title) => rootsOf(title).includes(target));
  if (index < 0) {
    return false;
  }
  const title = titles[index];

  // Clicking a menu item needs the application in front, and activation by pid never launches it.
  if (hostPid > 0) {
    try {
      await activateProcess(hostPid);
    } catch {
      return false;
    }
  }

  const clicked = await runAppleScript(`tell application "System Events"
  if not (exists process ${appleQuote(processName)}) then return "missing"
  tell process ${appleQuote(processName)}
    try
      repeat with mi in (menu items of menu 1 of menu bar item "Window" of menu bar 1)
        if (name of mi as text) is ${appleQuote(title)} then
          click mi
          return "ok"
        end if
      end repeat
    on error
      return "missing"
    end try
    try
      perform action "AXRaise" of (first window whose name is ${appleQuote(title)})
      return "ok"
    on error
      return "missing"
    end try
  end tell
end tell`);

  return clicked.trim() === "ok";
}
