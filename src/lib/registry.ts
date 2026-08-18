import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { agentStatusOf } from "./agents";
import { detectHost, HostInfo, HostKind, readProcessTable } from "./host";
import { isMissingOrDenied, REGISTRY_DIR } from "./paths";

/** Status string written by Claude Code itself. Known values: "busy", "idle", "shell". */
export type RegistryStatus = string;

export interface LiveSession {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string;
  readonly status: RegistryStatus;
  readonly kind: string;
  readonly entrypoint: string;
  readonly version: string;
  readonly startedAt: number | null;
  readonly statusUpdatedAt: number | null;
  /** Terminal or editor hosting the process, resolved from the parent chain. */
  readonly hostKind: HostKind;
  readonly hostApp: string;
  readonly hostPid: number;
  readonly tty: string;
  /** Reason a session is waiting, e.g. "permission prompt". From the CLI, empty otherwise. */
  readonly waitingFor: string;
}

const PID_FILE = /^(\d+)\.json$/;

/** A pid's host never changes, so the `ps` snapshot is only taken when an unseen pid shows up. */
const hostCache = new Map<number, HostInfo>();

async function resolveHosts(pids: readonly number[]): Promise<Map<number, HostInfo>> {
  for (const pid of hostCache.keys()) {
    if (!pids.includes(pid)) {
      hostCache.delete(pid);
    }
  }

  if (pids.every((pid) => hostCache.has(pid))) {
    return hostCache;
  }

  const table = await readProcessTable();
  for (const pid of pids) {
    if (hostCache.has(pid)) {
      continue;
    }
    const host = detectHost(pid, table);
    if (host !== null) {
      hostCache.set(pid, host);
    }
  }
  return hostCache;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Signal 0 probes existence without touching the process. EPERM means alive but not ours. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRegistryFile(raw: string, filePid: number): LiveSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const sessionId = optionalString(record.sessionId, "");
  if (sessionId.length === 0) {
    return null;
  }

  return {
    pid: optionalNumber(record.pid) ?? filePid,
    sessionId,
    cwd: optionalString(record.cwd, ""),
    name: optionalString(record.name, sessionId.slice(0, 8)),
    status: optionalString(record.status, "unknown"),
    kind: optionalString(record.kind, "unknown"),
    entrypoint: optionalString(record.entrypoint, "unknown"),
    version: optionalString(record.version, ""),
    startedAt: optionalNumber(record.startedAt),
    statusUpdatedAt: optionalNumber(record.statusUpdatedAt) ?? optionalNumber(record.updatedAt),
    hostKind: "unknown",
    hostApp: "",
    hostPid: 0,
    tty: "",
    waitingFor: "",
  };
}

/**
 * Reads every registry entry whose process is still alive.
 * Stale files (crashed processes) are dropped rather than reported as running.
 */
export async function readLiveSessions(): Promise<LiveSession[]> {
  let entries: string[];
  try {
    entries = await readdir(REGISTRY_DIR);
  } catch (error) {
    if (isMissingOrDenied(error)) {
      return [];
    }
    throw error;
  }

  const candidates = entries
    .map((name) => ({ name, match: PID_FILE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map((entry) => ({ name: entry.name, pid: Number.parseInt(entry.match[1], 10) }))
    .filter((entry) => isAlive(entry.pid));

  const [hosts, sessions] = await Promise.all([
    resolveHosts(candidates.map((candidate) => candidate.pid)),
    Promise.all(
      candidates.map(async ({ name, pid }) => {
        try {
          return parseRegistryFile(await readFile(join(REGISTRY_DIR, name), "utf8"), pid);
        } catch (error) {
          if (isMissingOrDenied(error)) {
            return null;
          }
          throw error;
        }
      }),
    ),
  ]);

  return sessions
    .filter((session): session is LiveSession => session !== null)
    .map((session) => {
      const host = hosts.get(session.pid);
      const withHost =
        host === undefined
          ? session
          : {
              ...session,
              hostKind: host.kind,
              hostApp: host.appName,
              hostPid: host.hostPid,
              tty: host.tty,
            };

      // The CLI knows about `waiting` and why; the registry file only carries busy/idle/shell.
      const fromCli = agentStatusOf(session.pid);
      return fromCli === null ? withHost : { ...withHost, status: fromCli.status, waitingFor: fromCli.waitingFor };
    })
    .sort((a, b) => (b.statusUpdatedAt ?? 0) - (a.statusUpdatedAt ?? 0));
}
