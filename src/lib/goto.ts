import { activateProcess } from "./activate";
import { focusItermTab, focusTerminalTab, raiseProjectWindow } from "./focus";
import { SessionItem } from "./sessions";
import { isInsideOpenProject, readOpenZedProjects } from "./zed-workspaces";

export interface GoToOptions {
  /** Set for a session whose process is alive but whose editor window is gone: it cannot be reached. */
  readonly unreachable?: boolean;
}

export type GoToResult =
  | { readonly kind: "reached"; readonly title: string; readonly message: string }
  /** Nothing hosts this session any more, so the caller decides whether to resume it. */
  | { readonly kind: "needs-resume" };

/** Activates the hosting application by pid, so nothing is ever launched to satisfy a jump. */
async function activateHost(pid: number, appName: string, message: string): Promise<GoToResult> {
  try {
    await activateProcess(pid);
    return { kind: "reached", title: `Activated ${appName}`, message };
  } catch {
    return { kind: "reached", title: `${appName} is no longer on screen`, message: "Nothing was launched" };
  }
}

/**
 * Moves to wherever the session already lives, and never creates anything:
 * the exact terminal tab when the host is scriptable, otherwise the editor window showing that
 * directory. Editors are only ever raised. Handing a path to a running editor can swap the
 * project of an existing window and take its terminals down with it, and launching one just to
 * resume a session would leave the running processes behind.
 */
export async function goToSession(item: SessionItem, options: GoToOptions = {}): Promise<GoToResult> {
  const live = options.unreachable === true ? null : item.live;
  if (live === null) {
    return { kind: "needs-resume" };
  }

  if (live.tty.length > 0 && (live.hostKind === "iterm" || live.hostKind === "terminal")) {
    const focused = live.hostKind === "iterm" ? await focusItermTab(live.tty) : await focusTerminalTab(live.tty);
    if (focused) {
      return { kind: "reached", title: `Jumped to ${live.hostApp}`, message: `${live.name} · ${live.tty}` };
    }
    return activateHost(live.hostPid, live.hostApp, `No tab on ${live.tty}`);
  }

  if (live.hostKind === "editor" && live.hostApp.length > 0) {
    const raised = await raiseProjectWindow(live.hostApp, item.cwd, live.hostPid);
    if (raised) {
      return {
        kind: "reached",
        title: `Moved to the ${live.hostApp} window`,
        message: `${live.name} · ${live.tty || "unknown tty"}`,
      };
    }

    // The window list can miss a project that is open as a second workspace inside another window.
    const openProjects = live.hostApp === "Zed" ? await readOpenZedProjects() : [];
    const message = isInsideOpenProject(item.cwd, openProjects)
      ? "Open as a workspace inside another window; switch to it there"
      : "No window shows this directory; nothing was opened";
    return activateHost(live.hostPid, live.hostApp, message);
  }

  if (live.hostPid > 0) {
    return activateHost(live.hostPid, live.hostApp.length > 0 ? live.hostApp : "the host application", live.name);
  }

  return { kind: "needs-resume" };
}
