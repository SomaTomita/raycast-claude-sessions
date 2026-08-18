import { basename } from "node:path";

import { run } from "./run";

/** Which application hosts a running session, and how precisely we can jump to it. */
export type HostKind = "iterm" | "terminal" | "editor" | "app" | "unknown";

export interface HostInfo {
  readonly kind: HostKind;
  /** macOS application name, taken from the `.app` bundle when there is one. */
  readonly appName: string;
  readonly hostPid: number;
  /** tty of the Claude process itself, e.g. `/dev/ttys002`. */
  readonly tty: string;
}

interface ProcessRow {
  readonly ppid: number;
  readonly tty: string;
  /** Full executable path from `ps -o comm=`, e.g. `/Applications/Zed.app/Contents/MacOS/zed`. */
  readonly command: string;
}

/**
 * Behaviour per host, keyed by application name. Anything not listed still works: an unknown
 * `.app` host is treated as `app`, which means activate-only. Only the apps we can drive more
 * precisely need an entry here.
 */
const HOST_KINDS: Record<string, HostKind> = {
  iTerm: "iterm",
  Terminal: "terminal",
  Zed: "editor",
  "Visual Studio Code": "editor",
  Cursor: "editor",
  Windsurf: "editor",
};

/** Terminals commonly installed as bare binaries rather than app bundles. */
const BARE_TERMINALS = /^(alacritty|ghostty|kitty|wezterm(-gui)?)$/i;

const MAX_CHAIN_DEPTH = 16;

/** Snapshot of the process table, keyed by pid. One `ps` call serves every session. */
export async function readProcessTable(): Promise<Map<number, ProcessRow>> {
  const table = new Map<number, ProcessRow>();
  let stdout: string;
  try {
    stdout = await run("/bin/ps", ["-axo", "pid=,ppid=,tty=,comm="]);
  } catch {
    return table;
  }

  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    table.set(pid, { ppid, tty: parts[2], command: parts.slice(3).join(" ") });
  }
  return table;
}

/** Application name of a process: the `.app` bundle name when present, else the binary name. */
export function appNameOf(command: string): string {
  const bundle = command.match(/\/([^/]+)\.app\//);
  return bundle !== null ? bundle[1] : basename(command);
}

/**
 * Whether a process looks like a GUI terminal or editor hosting a session: anything inside an
 * `.app` bundle, plus bare binaries of known terminals. Broader than the list of apps we can
 * script, on purpose, so an unrecognised host still gets activated rather than ignored.
 */
function isGuiHost(command: string): boolean {
  return command.includes(".app/") || BARE_TERMINALS.test(basename(command));
}

/** Walks the parent chain until it reaches a GUI application. */
export function detectHost(pid: number, table: Map<number, ProcessRow>): HostInfo | null {
  const self = table.get(pid);
  if (self === undefined) {
    return null;
  }
  const tty = self.tty === "??" || self.tty === "-" ? "" : `/dev/${self.tty}`;

  let current = self.ppid;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && current > 1; depth += 1) {
    const row = table.get(current);
    if (row === undefined) {
      break;
    }
    if (isGuiHost(row.command)) {
      const appName = appNameOf(row.command);
      return { kind: HOST_KINDS[appName] ?? "app", appName, hostPid: current, tty };
    }
    current = row.ppid;
  }

  return { kind: "unknown", appName: "", hostPid: 0, tty };
}

export async function isAppRunning(processName: string): Promise<boolean> {
  const table = await readProcessTable();
  const target = processName.toLowerCase();
  for (const row of table.values()) {
    if (basename(row.command).toLowerCase() === target || appNameOf(row.command).toLowerCase() === target) {
      return true;
    }
  }
  return false;
}
