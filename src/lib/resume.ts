import { existsSync } from "node:fs";

import { runAppleScript } from "@raycast/utils";

import { appleQuote, shellQuote } from "./quote";

const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

export type TerminalApp = "Terminal" | "iTerm";

export interface ResumeTarget {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface ResumeOptions {
  readonly terminal: TerminalApp;
  readonly claudeBin: string;
  readonly cwd: string;
  readonly sessionId: string;
}

/** `cd <cwd> && claude --resume <id>`, validated before it reaches a shell. */
export function resumeCommand(options: Pick<ResumeOptions, "claudeBin" | "cwd" | "sessionId">): string {
  if (!SESSION_ID.test(options.sessionId)) {
    throw new Error(`Unexpected session id: ${options.sessionId}`);
  }
  const bin = options.claudeBin.trim().length > 0 ? options.claudeBin.trim() : "claude";
  const cd = options.cwd.length > 0 ? `cd ${shellQuote(options.cwd)} && ` : "";
  return `${cd}${bin} --resume ${options.sessionId}`;
}

export async function resumeInTerminal(options: ResumeOptions): Promise<void> {
  await resumeManyInTerminal({
    terminal: options.terminal,
    claudeBin: options.claudeBin,
    targets: [{ sessionId: options.sessionId, cwd: options.cwd }],
  });
}

/**
 * Resumes one or more sessions in the terminal application.
 * iTerm2 gets one window with a tab per session; Terminal.app has no scriptable tab creation,
 * so it gets one window per session.
 *
 * Terminals are driven through AppleScript's own commands, never synthetic keystrokes: those
 * depend on the active keyboard layout, and an option-modified key can come out as a dead key.
 */
export async function resumeManyInTerminal(options: {
  readonly terminal: TerminalApp;
  readonly claudeBin: string;
  readonly targets: readonly ResumeTarget[];
}): Promise<void> {
  if (options.targets.length === 0) {
    throw new Error("Nothing to resume");
  }

  const commands = options.targets.map((target) => {
    if (target.cwd.length > 0 && !existsSync(target.cwd)) {
      throw new Error(`Directory no longer exists: ${target.cwd}`);
    }
    return resumeCommand({ claudeBin: options.claudeBin, cwd: target.cwd, sessionId: target.sessionId });
  });

  if (options.terminal === "iTerm") {
    const [first, ...rest] = commands;
    const tabs = rest
      .map(
        (command) => `  set t to (create tab with default profile)
  tell current session of t to write text ${appleQuote(command)}`,
      )
      .join("\n");

    await runAppleScript(`tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${appleQuote(first)}
  tell w
${tabs}
  end tell
end tell`);
    return;
  }

  const scripts = commands.map((command) => `  do script ${appleQuote(command)}`).join("\n");
  await runAppleScript(`tell application "Terminal"
  activate
${scripts}
end tell`);
}
