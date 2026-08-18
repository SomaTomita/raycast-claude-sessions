import { activateApp, focusItermTab, focusTerminalTab, raiseProjectWindow } from "./focus";
import { SessionItem } from "./sessions";

export interface GoToOptions {
  /** Set for a session whose process is alive but whose editor window is gone: it cannot be reached. */
  readonly unreachable?: boolean;
}

export type GoToResult =
  | { readonly kind: "reached"; readonly title: string; readonly message: string }
  /** Nothing hosts this session any more, so the caller decides whether to resume it. */
  | { readonly kind: "needs-resume" };

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
    await activateApp(live.hostApp);
    return { kind: "reached", title: `No tab on ${live.tty}`, message: `Activated ${live.hostApp}` };
  }

  if (live.hostKind === "editor" && live.hostApp.length > 0) {
    const raised = await raiseProjectWindow(live.hostApp, item.cwd);
    if (raised) {
      return {
        kind: "reached",
        title: `Moved to the ${live.hostApp} window`,
        message: `${live.name} · ${live.tty || "unknown tty"}`,
      };
    }
    await activateApp(live.hostApp);
    return {
      kind: "reached",
      title: `Activated ${live.hostApp}`,
      message: "No window shows this directory; nothing was opened",
    };
  }

  if (live.hostApp.length > 0) {
    await activateApp(live.hostApp);
    return { kind: "reached", title: `Activated ${live.hostApp}`, message: live.name };
  }

  return { kind: "needs-resume" };
}
