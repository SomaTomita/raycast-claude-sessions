import { execClaude } from "./claude-cli";

/**
 * `claude agents --all --json` is the CLI's own view of what is running: interactive sessions
 * (with a pid and a status that can be `waiting`, plus the reason) and background agents, which
 * have no process at all and are therefore invisible in `~/.claude/sessions`.
 */
export interface InteractiveAgent {
  readonly kind: "interactive";
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string;
  readonly startedAt: number | null;
  readonly pid: number;
  /** `busy` / `idle` / `waiting` today; treated as an open set. */
  readonly status: string;
  /** Set when status is `waiting`, e.g. "permission prompt". */
  readonly waitingFor: string;
}

export interface BackgroundAgent {
  readonly kind: "background";
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: string;
  readonly startedAt: number | null;
  /** Short job id, the target for `claude attach|stop|rm`. */
  readonly id: string;
  /** `done` / `blocked` today; treated as an open set. */
  readonly state: string;
}

export type Agent = InteractiveAgent | BackgroundAgent;

export interface AgentStatus {
  readonly status: string;
  readonly waitingFor: string;
}

/** pid -> status, so the 3s registry poll can show `waiting` without paying for a CLI call. */
const statusByPid = new Map<number, AgentStatus>();

/** The CLI call costs ~1s, and background jobs change slowly, so results are reused briefly. */
const CACHE_TTL_MS = 45_000;
let cached: { readonly at: number; readonly agents: readonly Agent[] } | null = null;

/** Drops the cache so the next read hits the CLI. Used by an explicit refresh. */
export function invalidateAgents(): void {
  cached = null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Validated per row: one malformed entry must not discard the whole list. */
function parseAgent(value: unknown): Agent | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const sessionId = str(record.sessionId);
  const cwd = str(record.cwd);
  const startedAt = num(record.startedAt);

  if (record.kind === "interactive") {
    const pid = num(record.pid);
    if (sessionId.length === 0 || pid === null) {
      return null;
    }
    return {
      kind: "interactive",
      sessionId,
      cwd,
      name: str(record.name, sessionId.slice(0, 8)),
      startedAt,
      pid,
      status: str(record.status, "unknown"),
      waitingFor: str(record.waitingFor),
    };
  }

  if (record.kind === "background") {
    const id = str(record.id);
    if (sessionId.length === 0 || id.length === 0) {
      return null;
    }
    return {
      kind: "background",
      sessionId,
      cwd,
      name: str(record.name, id),
      startedAt,
      id,
      state: str(record.state, "unknown"),
    };
  }

  return null;
}

/**
 * Reads the CLI's agent list and refreshes the pid status cache.
 * Costs ~0.4s, so it belongs on the slow refresh cycle, never the 3s poll.
 */
export async function readAgents(preferredBinary?: string): Promise<Agent[]> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) {
    return [...cached.agents];
  }

  const stdout = await execClaude(["agents", "--all", "--json"], preferredBinary);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("claude agents --json did not return JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("claude agents --json did not return an array");
  }

  const agents = parsed.map(parseAgent).filter((agent): agent is Agent => agent !== null);

  statusByPid.clear();
  for (const agent of agents) {
    if (agent.kind === "interactive") {
      statusByPid.set(agent.pid, { status: agent.status, waitingFor: agent.waitingFor });
    }
  }

  cached = { at: Date.now(), agents };
  return agents;
}

/** Cached CLI status for a pid, or null when the CLI has not been read yet. */
export function agentStatusOf(pid: number): AgentStatus | null {
  return statusByPid.get(pid) ?? null;
}
