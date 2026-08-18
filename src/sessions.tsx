import { Color, getPreferenceValues, Icon, List } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useEffect, useMemo, useState } from "react";

import { SessionActions } from "./components/session-actions";
import { SessionDetail } from "./components/session-detail";
import { editorProcessName } from "./lib/editor";
import { formatHomePath, projectName } from "./lib/format";
import { readRecentMessages, TranscriptMessage } from "./lib/messages";
import { LiveSession, readLiveSessions } from "./lib/registry";
import { TerminalApp } from "./lib/resume";
import { applyLiveSessions, loadSessions, SessionItem, SessionState } from "./lib/sessions";
import { listProjectRoots } from "./lib/windows";

/** The registry is a handful of tiny files, so live status can be polled aggressively. */
const LIVE_REFRESH_MS = 3_000;
/** Transcript rescans are memoised per mtime, but still cost a directory walk. */
const FULL_REFRESH_MS = 30_000;
const DEFAULT_HISTORY_LIMIT = 80;
const MAX_HISTORY_LIMIT = 500;
/** Turns shown in the detail pane. Only the selected session is read. */
const PREVIEW_TURNS = 10;

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
  closed: { section: "History", color: Color.SecondaryText },
};

const SECTION_ORDER: readonly SessionGroup[] = ["working", "waiting", "unreachable", "closed"];
/** Window titles change rarely, and each check is an accessibility round trip. */
const WINDOW_REFRESH_MS = 15_000;

/** Project roots currently open per editor process, e.g. `{ zed: ["migration", "repro-audit"] }`. */
async function loadOpenRoots(processList: string): Promise<Record<string, string[]>> {
  const processes = processList.split(",").filter((name) => name.length > 0);
  const entries = await Promise.all(
    processes.map(async (name): Promise<[string, string[]]> => [name, [...(await listProjectRoots(name))]]),
  );
  return Object.fromEntries(entries);
}

/**
 * True when a live editor-hosted session has no window showing its directory.
 * An empty root list means the lookup failed (no accessibility permission, say), so nothing is
 * flagged: a false "window gone" is worse than missing one.
 */
function isUnreachable(item: SessionItem, openRoots: Record<string, string[]>): boolean {
  const live = item.live;
  if (live === null || live.hostKind !== "editor") {
    return false;
  }
  const roots = openRoots[editorProcessName(live.hostApp)];
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

  const { data: scanned, isLoading, error, revalidate } = useCachedPromise(loadSessions, [historyLimit], {
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

  const { data: openRoots, revalidate: revalidateWindows } = useCachedPromise(loadOpenRoots, [editorProcesses], {
    keepPreviousData: true,
    initialData: {} as Record<string, string[]>,
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

  const liveCount = data.filter((item) => item.live !== null).length;

  /** Unreachable sessions grouped by directory, so one action can bring a whole project back. */
  const unreachableByCwd = useMemo(() => {
    const map = new Map<string, SessionItem[]>();
    for (const item of data) {
      if (!isUnreachable(item, openRoots)) {
        continue;
      }
      map.set(item.cwd, [...(map.get(item.cwd) ?? []), item]);
    }
    return map;
  }, [data, openRoots]);

  const selectedPath = useMemo(
    () => data.find((item) => item.key === selectedKey)?.transcript?.path ?? "",
    [data, selectedKey],
  );

  const { data: messages, isLoading: isLoadingMessages } = useCachedPromise(loadMessages, [selectedPath], {
    keepPreviousData: false,
    initialData: [] as TranscriptMessage[],
    execute: showDetail && selectedPath.length > 0,
  });

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
        const items = visible.filter((item) => (isUnreachable(item, openRoots) ? "unreachable" : item.state) === group);
        if (items.length === 0) {
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
                    messages={item.key === selectedKey ? messages : []}
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
                    siblings={
                      group === "unreachable"
                        ? (unreachableByCwd.get(item.cwd) ?? []).filter((other) => other.key !== item.key)
                        : []
                    }
                    onRefresh={() => {
                      revalidate();
                      revalidateLive();
                      revalidateWindows();
                    }}
                    onToggleDetail={() => setShowDetail((current) => !current)}
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
