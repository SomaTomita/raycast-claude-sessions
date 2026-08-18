import { cleanPrompt, projectName, shortId } from "./format";
import { PromptEntry, readRecentPrompts } from "./prompts";
import { LiveSession, readLiveSessions } from "./registry";
import { indexTranscripts, summarizeAll, TranscriptSummary } from "./transcript";

export type SessionState = "working" | "waiting" | "closed";

export interface SessionItem {
  /** Stable list key. One row per live process, so sessionId alone is not unique. */
  readonly key: string;
  readonly sessionId: string;
  readonly title: string;
  readonly state: SessionState;
  /** Raw status from the registry ("busy" / "idle" / "shell" / …), or "closed" when no process owns it. */
  readonly statusLabel: string;
  readonly live: LiveSession | null;
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
}

function stateOf(live: LiveSession | null): SessionState {
  if (live === null) {
    return "closed";
  }
  return live.status === "idle" ? "waiting" : "working";
}

function titleOf(transcript: TranscriptSummary | null, live: LiveSession | null, sessionId: string): string {
  const aiTitle = transcript?.aiTitle.trim() ?? "";
  if (aiTitle.length > 0) {
    return aiTitle;
  }
  const prompt = cleanPrompt(transcript?.firstPrompt ?? "", 90);
  if (prompt.length > 0) {
    return prompt;
  }
  if (live !== null && live.name.length > 0) {
    return live.name;
  }
  return shortId(sessionId);
}

function build(sessionId: string, live: LiveSession | null, context: SessionContext): SessionItem {
  const { transcript, lastPrompt } = context;
  const liveCwd = live?.cwd ?? "";
  const cwd = liveCwd.length > 0 ? liveCwd : (transcript?.cwd ?? lastPrompt?.project ?? "");
  const lastActivityMs = Math.max(
    transcript?.lastTimestampMs ?? 0,
    transcript?.mtimeMs ?? 0,
    live?.statusUpdatedAt ?? 0,
    lastPrompt?.timestampMs ?? 0,
  );

  return {
    key: live !== null ? `pid-${live.pid}` : `session-${sessionId}`,
    sessionId,
    title: titleOf(transcript, live, sessionId),
    state: stateOf(live),
    statusLabel: live?.status ?? "closed",
    live,
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

function byActivityDesc(a: SessionItem, b: SessionItem): number {
  return b.lastActivityMs - a.lastActivityMs;
}

function contextOf(item: SessionItem): SessionContext {
  return { transcript: item.transcript, lastPrompt: item.lastPrompt };
}

/**
 * Live processes (from the registry) plus the newest `historyLimit` transcripts,
 * sorted newest activity first. A session opened in two terminals yields two rows.
 */
export async function loadSessions(historyLimit: number): Promise<SessionItem[]> {
  const [live, index, prompts] = await Promise.all([readLiveSessions(), indexTranscripts(), readRecentPrompts()]);

  const filesById = new Map(index.map((file) => [file.sessionId, file]));

  // Always summarise live sessions, even when their transcript fell outside the recency window.
  const targets = new Map(index.slice(0, Math.max(1, historyLimit)).map((file) => [file.path, file]));
  for (const session of live) {
    const file = filesById.get(session.sessionId);
    if (file !== undefined) {
      targets.set(file.path, file);
    }
  }

  const summaries = await summarizeAll([...targets.values()]);
  const summaryById = new Map(summaries.map((summary) => [summary.sessionId, summary]));

  const contextFor = (sessionId: string): SessionContext => ({
    transcript: summaryById.get(sessionId) ?? null,
    lastPrompt: prompts.get(sessionId) ?? null,
  });

  const liveIds = new Set(live.map((session) => session.sessionId));
  const liveItems = live.map((session) => build(session.sessionId, session, contextFor(session.sessionId)));
  const closedItems = summaries
    .filter((summary) => !liveIds.has(summary.sessionId))
    .map((summary) => build(summary.sessionId, null, contextFor(summary.sessionId)));

  return [...liveItems, ...closedItems].sort(byActivityDesc);
}

/**
 * Re-stamps cached items with a fresh registry read so live status can be polled
 * without rescanning transcripts. Unchanged rows keep their object identity.
 */
export function applyLiveSessions(items: readonly SessionItem[], live: readonly LiveSession[]): SessionItem[] {
  const contexts = new Map<string, SessionContext>();
  for (const item of items) {
    if (!contexts.has(item.sessionId)) {
      contexts.set(item.sessionId, contextOf(item));
    }
  }

  const liveIds = new Set(live.map((session) => session.sessionId));
  const liveItems = live.map((session) => {
    const unchanged = items.find(
      (item) => item.live !== null && item.live.pid === session.pid && item.live.status === session.status,
    );
    if (unchanged !== undefined && unchanged.sessionId === session.sessionId) {
      return unchanged;
    }
    return build(session.sessionId, session, contexts.get(session.sessionId) ?? { transcript: null, lastPrompt: null });
  });

  // Sessions whose process disappeared fall back to a single history row.
  const closedById = new Map<string, SessionItem>();
  for (const item of items) {
    if (liveIds.has(item.sessionId) || closedById.has(item.sessionId)) {
      continue;
    }
    closedById.set(item.sessionId, item.live === null ? item : build(item.sessionId, null, contextOf(item)));
  }

  return [...liveItems, ...closedById.values()].sort(byActivityDesc);
}
