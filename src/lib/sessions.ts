import { Agent, BackgroundAgent, readAgents } from "./agents";
import { cleanPrompt, projectName, shortId } from "./format";
import { PromptEntry, readRecentPrompts } from "./prompts";
import { LiveSession, readLiveSessions } from "./registry";
import { indexTranscripts, summarizeAll, TranscriptSummary } from "./transcript";

export type SessionState = "working" | "waiting" | "background" | "closed";

export interface SessionItem {
  /** Stable list key. One row per live process or background job, so sessionId alone is not unique. */
  readonly key: string;
  readonly sessionId: string;
  readonly title: string;
  readonly state: SessionState;
  /** Raw status: registry/CLI value for a process, job state for a background agent, else "closed". */
  readonly statusLabel: string;
  readonly live: LiveSession | null;
  /** Set for a background agent: no process, managed with `claude attach|stop|rm`. */
  readonly agent: BackgroundAgent | null;
  readonly transcript: TranscriptSummary | null;
  readonly lastPrompt: PromptEntry | null;
  readonly cwd: string;
  readonly project: string;
  readonly gitBranch: string;
  readonly model: string;
  readonly lastActivityMs: number;
  readonly messageCount: number | null;
  /** false when messageCount is a lower bound (sampled from a very large transcript). */
  readonly messageCountExact: boolean;
}

interface SessionContext {
  readonly transcript: TranscriptSummary | null;
  readonly lastPrompt: PromptEntry | null;
  readonly agent: BackgroundAgent | null;
}

function stateOf(live: LiveSession | null, agent: BackgroundAgent | null): SessionState {
  if (live !== null) {
    return live.status === "idle" ? "waiting" : "working";
  }
  return agent !== null ? "background" : "closed";
}

function titleOf(context: SessionContext, live: LiveSession | null, sessionId: string): string {
  const aiTitle = context.transcript?.aiTitle.trim() ?? "";
  if (aiTitle.length > 0) {
    return aiTitle;
  }
  const prompt = cleanPrompt(context.transcript?.firstPrompt ?? "", 90);
  if (prompt.length > 0) {
    return prompt;
  }
  const name = live?.name ?? context.agent?.name ?? "";
  return name.length > 0 ? name : shortId(sessionId);
}

function build(sessionId: string, live: LiveSession | null, context: SessionContext): SessionItem {
  const { transcript, lastPrompt, agent } = context;
  const declaredCwd = live?.cwd ?? agent?.cwd ?? "";
  const cwd = declaredCwd.length > 0 ? declaredCwd : (transcript?.cwd ?? lastPrompt?.project ?? "");
  const lastActivityMs = Math.max(
    transcript?.lastTimestampMs ?? 0,
    transcript?.mtimeMs ?? 0,
    live?.statusUpdatedAt ?? 0,
    lastPrompt?.timestampMs ?? 0,
    agent?.startedAt ?? 0,
  );

  const key = live !== null ? `pid-${live.pid}` : agent !== null ? `job-${agent.id}` : `session-${sessionId}`;

  return {
    key,
    sessionId,
    title: titleOf(context, live, sessionId),
    state: stateOf(live, agent),
    statusLabel: live?.status ?? agent?.state ?? "closed",
    live,
    agent,
    transcript,
    lastPrompt,
    cwd,
    project: projectName(cwd, transcript?.projectSlug ?? ""),
    gitBranch: transcript?.gitBranch ?? "",
    model: transcript?.model ?? "",
    lastActivityMs,
    messageCount: transcript?.messageCount ?? null,
    messageCountExact: transcript?.messageCountExact ?? true,
  };
}

/**
 * Every field of a live session that the list renders or sorts by. `statusUpdatedAt` matters most:
 * reusing a row whose status happens to match would otherwise freeze its last-activity stamp, and
 * `byActivityDesc` would sort a continuously busy session below one that merely changed state.
 */
function sameLiveSession(a: LiveSession, b: LiveSession): boolean {
  return (
    a.pid === b.pid &&
    a.sessionId === b.sessionId &&
    a.status === b.status &&
    a.waitingFor === b.waitingFor &&
    a.statusUpdatedAt === b.statusUpdatedAt &&
    a.name === b.name &&
    a.cwd === b.cwd &&
    a.tty === b.tty &&
    a.hostApp === b.hostApp &&
    a.hostPid === b.hostPid
  );
}

function byActivityDesc(a: SessionItem, b: SessionItem): number {
  return b.lastActivityMs - a.lastActivityMs;
}

function contextOf(item: SessionItem): SessionContext {
  return { transcript: item.transcript, lastPrompt: item.lastPrompt, agent: item.agent };
}

/** The CLI is optional: a missing or failing binary must not break the session list. */
async function loadAgents(claudeBin?: string): Promise<Agent[]> {
  try {
    return await readAgents(claudeBin);
  } catch {
    return [];
  }
}

/**
 * Live processes (registry), background agents (CLI), and the newest `historyLimit` transcripts,
 * sorted newest activity first. A session opened in two terminals yields two rows.
 */
export async function loadSessions(historyLimit: number, claudeBin?: string): Promise<SessionItem[]> {
  // Agents first: reading them fills the pid status cache that readLiveSessions merges in.
  const agents = await loadAgents(claudeBin);
  const [live, index, prompts] = await Promise.all([readLiveSessions(), indexTranscripts(), readRecentPrompts()]);

  const filesById = new Map(index.map((file) => [file.sessionId, file]));

  // Always summarise live and background sessions, even when their transcript is outside the window.
  const targets = new Map(index.slice(0, Math.max(1, historyLimit)).map((file) => [file.path, file]));
  for (const sessionId of [...live.map((session) => session.sessionId), ...agents.map((agent) => agent.sessionId)]) {
    const file = filesById.get(sessionId);
    if (file !== undefined) {
      targets.set(file.path, file);
    }
  }

  const summaries = await summarizeAll([...targets.values()]);
  const summaryById = new Map(summaries.map((summary) => [summary.sessionId, summary]));

  const contextFor = (sessionId: string, agent: BackgroundAgent | null = null): SessionContext => ({
    transcript: summaryById.get(sessionId) ?? null,
    lastPrompt: prompts.get(sessionId) ?? null,
    agent,
  });

  const liveIds = new Set(live.map((session) => session.sessionId));
  const liveItems = live.map((session) => build(session.sessionId, session, contextFor(session.sessionId)));

  const backgroundAgents = agents.filter(
    (agent): agent is BackgroundAgent => agent.kind === "background" && !liveIds.has(agent.sessionId),
  );
  const backgroundIds = new Set(backgroundAgents.map((agent) => agent.sessionId));
  const backgroundItems = backgroundAgents.map((agent) =>
    build(agent.sessionId, null, contextFor(agent.sessionId, agent)),
  );

  const closedItems = summaries
    .filter((summary) => !liveIds.has(summary.sessionId) && !backgroundIds.has(summary.sessionId))
    .map((summary) => build(summary.sessionId, null, contextFor(summary.sessionId)));

  return [...liveItems, ...backgroundItems, ...closedItems].sort(byActivityDesc);
}

/**
 * Re-stamps cached items with a fresh registry read so live status can be polled
 * without rescanning transcripts. Unchanged rows keep their object identity.
 */
export function applyLiveSessions(items: readonly SessionItem[], live: readonly LiveSession[]): SessionItem[] {
  // One pass: the previous row per session (for transcript context) and per pid (for identity reuse).
  // Contexts are derived lazily below, so a 500 row history does not allocate 500 throwaway objects.
  const previousBySession = new Map<string, SessionItem>();
  const previousByPid = new Map<number, SessionItem>();
  for (const item of items) {
    if (!previousBySession.has(item.sessionId)) {
      previousBySession.set(item.sessionId, item);
    }
    if (item.live !== null) {
      previousByPid.set(item.live.pid, item);
    }
  }

  const liveIds = new Set(live.map((session) => session.sessionId));

  const liveItems = live.map((session) => {
    const previous = previousByPid.get(session.pid);
    if (previous !== undefined && previous.live !== null && sameLiveSession(previous.live, session)) {
      return previous;
    }
    const source = previousBySession.get(session.sessionId);
    const context: SessionContext =
      source === undefined
        ? { transcript: null, lastPrompt: null, agent: null }
        : { transcript: source.transcript, lastPrompt: source.lastPrompt, agent: null };
    return build(session.sessionId, session, context);
  });

  // Sessions whose process disappeared fall back to a single history row; background rows pass through.
  const restById = new Map<string, SessionItem>();
  for (const item of items) {
    if (liveIds.has(item.sessionId) || restById.has(item.sessionId)) {
      continue;
    }
    restById.set(item.sessionId, item.live === null ? item : build(item.sessionId, null, contextOf(item)));
  }

  return [...liveItems, ...restById.values()].sort(byActivityDesc);
}
