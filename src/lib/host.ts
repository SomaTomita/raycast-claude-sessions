import { basename } from "node:path";

import { run } from "./run";

/** Which application hosts a running session, and how precisely we can jump to it. */
export type HostKind = "iterm" | "terminal" | "editor" | "app" | "unknown";

export interface HostInfo {
  readonly kind: HostKind;
  /** macOS application name, usable with AppleScript / `open -a`. */
  readonly appName: string;
  readonly hostPid: number;
  /** tty of the Claude process itself, e.g. `/dev/ttys002`. */
  readonly tty: string;
}

interface ProcessRow {
  readonly ppid: number;
  readonly tty: string;
  readonly command: string;
}

const HOSTS: readonly { readonly match: RegExp; readonly kind: HostKind; readonly appName: string }[] = [
  { match: /^iterm(2|server.*)?$/i, kind: "iterm", appName: "iTerm" },
  { match: /^terminal$/i, kind: "terminal", appName: "Terminal" },
  { match: /^zed$/i, kind: "editor", appName: "Zed" },
  { match: /^(code|code helper.*|electron)$/i, kind: "editor", appName: "Visual Studio Code" },
  { match: /^cursor.*$/i, kind: "editor", appName: "Cursor" },
  { match: /^(warp|warpterminal)$/i, kind: "app", appName: "Warp" },
  { match: /^ghostty$/i, kind: "app", appName: "Ghostty" },
  { match: /^wezterm(-gui)?$/i, kind: "app", appName: "WezTerm" },
  { match: /^kitty$/i, kind: "app", appName: "kitty" },
  { match: /^alacritty$/i, kind: "app", appName: "Alacritty" },
  { match: /^hyper$/i, kind: "app", appName: "Hyper" },
];

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

/** Walks the parent chain until it reaches a known terminal or editor. */
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
    const name = basename(row.command);
    const host = HOSTS.find((candidate) => candidate.match.test(name));
    if (host !== undefined) {
      return { kind: host.kind, appName: host.appName, hostPid: current, tty };
    }
    current = row.ppid;
  }

  return { kind: "unknown", appName: "", hostPid: 0, tty };
}

export async function isAppRunning(appName: string): Promise<boolean> {
  const table = await readProcessTable();
  for (const row of table.values()) {
    if (basename(row.command).toLowerCase() === appName.toLowerCase()) {
      return true;
    }
  }
  return false;
}
