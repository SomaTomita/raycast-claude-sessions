import { Color, getPreferenceValues, Icon, List } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SessionActions } from "./components/session-actions";
import { SessionDetail } from "./components/session-detail";
import { editorProcessName } from "./lib/editor";
import { formatHomePath, projectName } from "./lib/format";
import { readRecentMessages, TranscriptMessage } from "./lib/messages";
import { LiveSession, readLiveSessions } from "./lib/registry";
import { TerminalApp } from "./lib/resume";
import { invalidateAgents } from "./lib/agents";
import { applyLiveSessions, loadSessions, SessionItem, SessionState } from "./lib/sessions";
import { listProjectRoots } from "./lib/windows";
import { isInsideOpenProject, readOpenZedProjects } from "./lib/zed-workspaces";

/** The registry is a handful of tiny files, so live status can be polled aggressively. */
const LIVE_REFRESH_MS = 3_000;
/** Transcript rescans are memoised per mtime, but still cost a directory walk. */
const FULL_REFRESH_MS = 30_000;
const DEFAULT_HISTORY_LIMIT = 80;
const MAX_HISTORY_LIMIT = 500;
/** Turns shown in the detail pane. Only the selected session is read. */
const PREVIEW_TURNS = 10;

/** Frozen and shared: every non-selected row passes the same empty array instead of allocating one. */
const NO_MESSAGES: readonly TranscriptMessage[] = Object.freeze([]);
const NO_SIBLINGS: readonly SessionItem[] = Object.freeze([]);

interface Preferences {
  readonly terminalApp?: TerminalApp;
  readonly editorApp?: string;
  readonly claudeBin?: string;
  readonly historyLimit?: string;
}

/** `unreachable` is a live process whose editor window is gone, so nothing can reach its terminal. */
type SessionGroup = SessionState | "unreachable";

const GROUP_META: Record<SessionGroup, { readonly section: string; readonly color: Color }> = {
  working: { section: "Working", color: Color.Green },
  waiting: { section: "Idle · awaiting input", color: Color.Blue },
  unreachable: { section: "Running · window gone", color: Color.Orange },
  background: { section: "Background agents", color: Color.Purple },
  closed: { section: "History", color: Color.SecondaryText },
};

const SECTION_ORDER: readonly SessionGroup[] = ["working", "waiting", "unreachable", "background", "closed"];
/** Window titles change rarely, and each check is an accessibility round trip. */
const WINDOW_REFRESH_MS = 15_000;

interface OpenProjects {
  /** Project roots per editor process, from window titles, e.g. `{ zed: ["migration"] }`. */
  readonly roots: Record<string, string[]>;
  /** Absolute paths Zed has open, including workspaces that share a window with another project. */
  readonly zedPaths: string[];
}

async function loadOpenProjects(processList: string): Promise<OpenProjects> {
  const processes = processList.split(",").filter((name) => name.length > 0);
  const [entries, zedPaths] = await Promise.all([
    Promise.all(processes.map(async (name): Promise<[string, string[]]> => [name, [...(await listProjectRoots(name))]])),
    processes.includes("zed") ? readOpenZedProjects() : Promise.resolve([]),
  ]);
  return { roots: Object.fromEntries(entries), zedPaths };
}

/**
 * True when a live editor-hosted session has nowhere to jump to: no window shows its directory and
 * the editor does not report it as an open project either.
 * An empty lookup means the state could not be read, so nothing is flagged: a false "window gone"
 * is worse than a missing one.
 */
function isUnreachable(item: SessionItem, open: OpenProjects): boolean {
  const live = item.live;
  if (live === null || live.hostKind !== "editor") {
    return false;
  }
  if (isInsideOpenProject(item.cwd, open.zedPaths)) {
    return false;
  }
  const roots = open.roots[editorProcessName(live.hostApp)];
  if (roots === undefined || roots.length === 0) {
    return false;
  }
  return !roots.includes(projectName(item.cwd, item.project));
}

function parseHistoryLimit(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(parsed, MAX_HISTORY_LIMIT);
}

/**
 * The directory the session was opened in, since that is what tells two sessions apart.
 * With the detail pane open the column is only about a third of the window, so it shrinks
 * to the last path segment instead of truncating a full path into uselessness.
 */
function subtitle(item: SessionItem, compact: boolean): string {
  const path = formatHomePath(item.cwd);
  if (path.length === 0) {
    return item.project;
  }
  return compact ? projectName(item.cwd, item.project) : path;
}

async function loadMessages(path: string): Promise<TranscriptMessage[]> {
  return path.length === 0 ? [] : readRecentMessages(path, PREVIEW_TURNS);
}

/** Wide rows carry only what identifies a session: where it runs and whether it is busy. */
function accessories(item: SessionItem, group: SessionGroup): List.Item.Accessory[] {
  const result: List.Item.Accessory[] = [];
  if (group === "unreachable") {
    result.push({ tag: { value: "no window", color: Color.Orange }, tooltip: "Process alive, but no editor window" });
  }
  if (item.live !== null && item.live.waitingFor.length > 0) {
    result.push({ tag: { value: item.live.waitingFor, color: Color.Red }, tooltip: "Waiting for you" });
  }
  if (item.agent !== null) {
    result.push({ tag: { value: item.agent.state, color: Color.Purple }, tooltip: `Background job ${item.agent.id}` });
  }
  if (item.live !== null) {
    result.push({
      tag: { value: item.statusLabel, color: GROUP_META[group].color },
      tooltip: `${item.live.hostApp || "unknown host"} · pid ${item.live.pid}`,
    });
  }
  if (item.lastActivityMs > 0) {
    result.push({ date: new Date(item.lastActivityMs), tooltip: "Last activity" });
  }
  return result;
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const historyLimit = parseHistoryLimit(preferences.historyLimit);
  const terminal: TerminalApp = preferences.terminalApp === "iTerm" ? "iTerm" : "Terminal";
  const editor = preferences.editorApp?.trim().length ? preferences.editorApp.trim() : "Zed";
  const claudeBin = preferences.claudeBin?.trim().length ? preferences.claudeBin.trim() : "claude";

  // Wide rows by default: title, directory, status. The detail pane is opt-in via ⌘D.
  const [showDetail, setShowDetail] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: scanned, isLoading, error, revalidate } = useCachedPromise(loadSessions, [historyLimit, claudeBin], {
    keepPreviousData: true,
    initialData: [] as SessionItem[],
  });

  const { data: live, revalidate: revalidateLive } = useCachedPromise(readLiveSessions, [], {
    keepPreviousData: true,
    initialData: [] as LiveSession[],
  });

  useEffect(() => {
    const liveTimer = setInterval(revalidateLive, LIVE_REFRESH_MS);
    const fullTimer = setInterval(revalidate, FULL_REFRESH_MS);
    return () => {
      clearInterval(liveTimer);
      clearInterval(fullTimer);
    };
  }, [revalidate, revalidateLive]);

  const data = useMemo(() => applyLiveSessions(scanned, live), [scanned, live]);

  const editorProcesses = useMemo(
    () =>
      [...new Set(live.filter((session) => session.hostKind === "editor").map((session) => editorProcessName(session.hostApp)))]
        .sort()
        .join(","),
    [live],
  );

  const { data: openProjects, revalidate: revalidateWindows } = useCachedPromise(loadOpenProjects, [editorProcesses], {
    keepPreviousData: true,
    initialData: { roots: {}, zedPaths: [] } as OpenProjects,
    execute: editorProcesses.length > 0,
  });

  useEffect(() => {
    const timer = setInterval(revalidateWindows, WINDOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [revalidateWindows]);

  useEffect(() => {
    if (error !== undefined) {
      void showFailureToast(error, { title: "Could not read Claude Code sessions" });
    }
  }, [error]);

  const projects = useMemo(() => {
    const names = new Set(data.map((item) => item.project).filter((name) => name.length > 0));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const visible = useMemo(() => {
    if (filter === "live") {
      return data.filter((item) => item.live !== null);
    }
    if (filter.startsWith("project:")) {
      const project = filter.slice("project:".length);
      return data.filter((item) => item.project === project);
    }
    return data;
  }, [data, filter]);

  const liveCount = useMemo(() => data.filter((item) => item.live !== null).length, [data]);

  /**
   * Unreachable rows grouped by directory, so one action can bring a whole project back.
   * The arrays are built here and never mutated afterwards; the push is a local accumulator that
   * keeps this O(n) instead of copying the bucket per item.
   */
  const unreachableByCwd = useMemo(() => {
    const byCwd = new Map<string, SessionItem[]>();
    for (const item of data) {
      if (!isUnreachable(item, openProjects)) {
        continue;
      }
      const bucket = byCwd.get(item.cwd);
      if (bucket === undefined) {
        byCwd.set(item.cwd, [item]);
      } else {
        bucket.push(item);
      }
    }
    return byCwd;
  }, [data, openProjects]);

  /** Rows bucketed by the section they render in, in one pass over what the filter left. */
  const sections = useMemo(() => {
    const bySection = new Map<SessionGroup, SessionItem[]>();
    for (const item of visible) {
      const group: SessionGroup = isUnreachable(item, openProjects) ? "unreachable" : item.state;
      const bucket = bySection.get(group);
      if (bucket === undefined) {
        bySection.set(group, [item]);
      } else {
        bucket.push(item);
      }
    }
    return bySection;
  }, [visible, openProjects]);

  const selectedPath = useMemo(
    () => data.find((item) => item.key === selectedKey)?.transcript?.path ?? "",
    [data, selectedKey],
  );

  const { data: messages, isLoading: isLoadingMessages } = useCachedPromise(loadMessages, [selectedPath], {
    keepPreviousData: false,
    initialData: [] as TranscriptMessage[],
    execute: showDetail && selectedPath.length > 0,
  });

  const handleRefresh = useCallback(() => {
    invalidateAgents();
    revalidate();
    revalidateLive();
    revalidateWindows();
  }, [revalidate, revalidateLive, revalidateWindows]);

  const handleToggleDetail = useCallback(() => setShowDetail((current) => !current), []);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showDetail}
      onSelectionChange={setSelectedKey}
      searchBarPlaceholder={`Search ${data.length} sessions · ${liveCount} live`}
      searchBarAccessory={
        <List.Dropdown tooltip="Filter" value={filter} onChange={setFilter} storeValue>
          <List.Dropdown.Item title="All sessions" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="Live only" value="live" icon={Icon.CircleFilled} />
          <List.Dropdown.Section title="Projects">
            {projects.map((project) => (
              <List.Dropdown.Item key={project} title={project} value={`project:${project}`} icon={Icon.Folder} />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      <List.EmptyView
        icon={Icon.Terminal}
        title={isLoading ? "Reading sessions…" : "No Claude Code sessions found"}
        description="Sessions are read from ~/.claude/sessions and ~/.claude/projects."
      />
      {SECTION_ORDER.map((group) => {
        const items = sections.get(group);
        if (items === undefined) {
          return null;
        }
        return (
          <List.Section key={group} title={GROUP_META[group].section} subtitle={String(items.length)}>
            {items.map((item) => (
              <List.Item
                key={item.key}
                id={item.key}
                icon={{ source: Icon.CircleFilled, tintColor: GROUP_META[group].color }}
                title={item.title}
                subtitle={subtitle(item, showDetail)}
                keywords={[item.sessionId, item.project, item.gitBranch, item.cwd].filter((word) => word.length > 0)}
                accessories={showDetail ? undefined : accessories(item, group)}
                detail={
                  <SessionDetail
                    item={item}
                    messages={item.key === selectedKey ? messages : NO_MESSAGES}
                    isLoadingMessages={item.key === selectedKey && isLoadingMessages}
                  />
                }
                actions={
                  <SessionActions
                    item={item}
                    terminal={terminal}
                    editor={editor}
                    claudeBin={claudeBin}
                    unreachable={group === "unreachable"}
                    background={group === "background"}
                    siblings={
                      group === "unreachable"
                        ? (unreachableByCwd.get(item.cwd) ?? NO_SIBLINGS).filter((other) => other.key !== item.key)
                        : NO_SIBLINGS
                    }
                    onRefresh={handleRefresh}
                    onToggleDetail={handleToggleDetail}
                  />
                }
              />
            ))}
          </List.Section>
        );
      })}
    </List>
  );
}
