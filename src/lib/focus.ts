import { runAppleScript } from "@raycast/utils";

import { editorProcessName, openProjectInNewWindow } from "./editor";
import { appleQuote } from "./quote";
import { focusProjectWindow } from "./windows";

/** Selects the exact iTerm2 tab running on `tty`. Returns false when no tab matches. */
export async function focusItermTab(tty: string): Promise<boolean> {
  const result = await runAppleScript(`tell application "iTerm"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is ${appleQuote(tty)} then
          select w
          select t
          select s
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "missing"
end tell`);
  return result.trim() === "ok";
}

/** Selects the exact Terminal.app tab running on `tty`. */
export async function focusTerminalTab(tty: string): Promise<boolean> {
  const result = await runAppleScript(`tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) is ${appleQuote(tty)} then
        set frontmost of w to true
        set selected of t to true
        return "ok"
      end if
    end repeat
  end repeat
  return "missing"
end tell`);
  return result.trim() === "ok";
}

/**
 * Raises the window already showing `cwd`, and only opens a new window when there is none.
 * Returns true when an existing window was reused.
 */
export async function revealProject(appName: string, cwd: string): Promise<boolean> {
  if (await focusProjectWindow(appName, editorProcessName(appName), cwd)) {
    return true;
  }
  await openProjectInNewWindow(appName, cwd);
  return false;
}

/** Raises the window for `cwd` if it exists. Never opens, launches, or replaces anything. */
export async function raiseProjectWindow(appName: string, cwd: string): Promise<boolean> {
  return focusProjectWindow(appName, editorProcessName(appName), cwd);
}
