import { basename } from "node:path";

import { runAppleScript } from "@raycast/utils";

import { appleQuote } from "./quote";

/** Zed titles windows `project — active file`; a multi-root workspace lists roots as `a, b`. */
const TITLE_SEPARATOR = " — ";
const ROOT_SEPARATOR = ", ";

/** Window titles of a running application, in window order. Empty when the app is not running. */
export async function listWindowTitles(processName: string): Promise<string[]> {
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

  return output.split("\n").map((line) => line.trim());
}

/** Every project root currently shown by that application's windows. */
export async function listProjectRoots(processName: string): Promise<Set<string>> {
  let titles: string[];
  try {
    titles = await listWindowTitles(processName);
  } catch {
    return new Set();
  }
  return new Set(titles.flatMap(rootsOf));
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
 * Raises the existing window for `cwd` and returns true.
 * Returns false when no window matches, leaving the application untouched, so the caller can
 * decide to open a new window instead of mutating an existing workspace.
 *
 * Matching is by folder name: window titles carry no path, so two projects sharing a basename
 * cannot be told apart. The first match wins.
 */
export async function focusProjectWindow(appName: string, processName: string, cwd: string): Promise<boolean> {
  const target = basename(cwd);
  if (target.length === 0) {
    return false;
  }

  let titles: string[];
  try {
    titles = await listWindowTitles(processName);
  } catch {
    return false;
  }

  const index = titles.findIndex((title) => rootsOf(title).includes(target));
  if (index < 0) {
    return false;
  }

  await runAppleScript(`tell application "System Events"
  tell process ${appleQuote(processName)}
    perform action "AXRaise" of window ${index + 1}
  end tell
end tell
tell application ${appleQuote(appName)} to activate`);
  return true;
}
