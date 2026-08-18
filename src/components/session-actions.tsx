import { Action, ActionPanel, Alert, confirmAlert, Icon, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { editorLabel } from "../lib/editor";
import { revealProject } from "../lib/focus";
import { goToSession } from "../lib/goto";
import { quitProcess } from "../lib/processes";
import { resumeCommand, resumeManyInTerminal, TerminalApp } from "../lib/resume";
import { SessionItem } from "../lib/sessions";
import { TranscriptView } from "./transcript-view";

interface Props {
  readonly item: SessionItem;
  readonly terminal: TerminalApp;
  readonly editor: string;
  readonly claudeBin: string;
  /** Live process with no editor window left: treat it like history, and offer to clean it up. */
  readonly unreachable: boolean;
  /** Every other session in the same directory that cannot be reached either. */
  readonly siblings: readonly SessionItem[];
  readonly onRefresh: () => void;
  readonly onToggleDetail: () => void;
}

function terminalLabel(terminal: TerminalApp): string {
  return terminal === "iTerm" ? "iTerm2" : "Terminal";
}

export function SessionActions({
  item,
  terminal,
  editor,
  claudeBin,
  unreachable,
  siblings,
  onRefresh,
  onToggleDetail,
}: Props) {
  const isLive = item.live !== null && !unreachable;

  /** Resumes `targets`, first offering to quit the stale processes still holding those sessions. */
  async function resume(targets: readonly SessionItem[], heading: string) {
    const stale = targets.filter((target) => target.live !== null);
    if (stale.length > 0) {
      const pids = stale.map((target) => `${target.live?.name} (pid ${target.live?.pid})`).join(", ");
      const confirmed = await confirmAlert({
        title: heading,
        message: `${stale.length === 1 ? "This session is" : "These sessions are"} still held by a process with no window: ${pids}. Quitting it first keeps a single process per transcript.`,
        icon: Icon.Terminal,
        primaryAction: { title: "Quit Stale and Resume", style: Alert.ActionStyle.Destructive },
      });
      if (!confirmed) {
        return;
      }
      for (const target of stale) {
        const pid = target.live?.pid;
        if (pid !== undefined) {
          try {
            quitProcess(pid);
          } catch (error) {
            await showFailureToast(error, { title: `Could not quit pid ${pid}` });
            return;
          }
        }
      }
    }

    try {
      await resumeManyInTerminal({
        terminal,
        claudeBin,
        targets: targets.map((target) => ({ sessionId: target.sessionId, cwd: target.cwd })),
      });
      await showToast({
        style: Toast.Style.Success,
        title: `Resuming ${targets.length === 1 ? "session" : `${targets.length} sessions`} in ${terminalLabel(terminal)}`,
        message: targets.length === 1 ? targets[0].title : targets.map((target) => target.project).join(", "),
      });
      onRefresh();
    } catch (error) {
      await showFailureToast(error, { title: "Could not resume" });
    }
  }

  async function goTo() {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Locating session…" });
    try {
      const result = await goToSession(item, { unreachable });
      if (result.kind === "reached") {
        toast.style = Toast.Style.Success;
        toast.title = result.title;
        toast.message = result.message;
        return;
      }
      toast.hide();
      await resume([item], `Resume ${item.title} in ${terminalLabel(terminal)}?`);
    } catch (error) {
      toast.hide();
      await showFailureToast(error, { title: "Could not reach the session" });
    }
  }

  async function openEditor() {
    try {
      const reused = await revealProject(editor, item.cwd);
      if (!reused) {
        await showToast({
          style: Toast.Style.Success,
          title: `Opened a new ${editorLabel(editor)} window`,
          message: item.project,
        });
      }
    } catch (error) {
      await showFailureToast(error, { title: `Could not open ${editorLabel(editor)}` });
    }
  }

  async function quitStale() {
    const live = item.live;
    if (live === null) {
      return;
    }
    const confirmed = await confirmAlert({
      title: `Quit ${live.name}?`,
      message: `Sends SIGTERM to pid ${live.pid}. The transcript stays on disk and the session can be resumed later.`,
      icon: Icon.XMarkCircle,
      primaryAction: { title: "Quit Process", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }
    try {
      quitProcess(live.pid);
      await showToast({ style: Toast.Style.Success, title: `Quit pid ${live.pid}`, message: live.name });
      onRefresh();
    } catch (error) {
      await showFailureToast(error, { title: "Could not quit the process" });
    }
  }

  function command(): string {
    try {
      return resumeCommand({ claudeBin, cwd: item.cwd, sessionId: item.sessionId });
    } catch {
      return `claude --resume ${item.sessionId}`;
    }
  }

  const projectGroup = [item, ...siblings];
  const goToTitle = isLive
    ? `Go to Session${item.live?.hostApp ? ` in ${item.live.hostApp}` : ""}`
    : `Resume in ${terminalLabel(terminal)}`;

  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action title={goToTitle} icon={isLive ? Icon.ArrowRight : Icon.Terminal} onAction={goTo} />
        {siblings.length > 0 ? (
          <Action
            title={`Resume All ${projectGroup.length} in ${item.project}`}
            icon={Icon.CopyClipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
            onAction={() =>
              resume(projectGroup, `Resume ${projectGroup.length} sessions from ${item.project} in ${terminalLabel(terminal)}?`)
            }
          />
        ) : null}
        <Action
          title={`Move to ${editorLabel(editor)}`}
          icon={Icon.Code}
          shortcut={{ modifiers: ["cmd"], key: "e" }}
          onAction={openEditor}
        />
        {item.transcript !== null ? (
          <Action.Push
            title="Open Transcript"
            icon={Icon.Document}
            shortcut={{ modifiers: ["cmd"], key: "return" }}
            target={<TranscriptView item={item} />}
          />
        ) : null}
        {item.cwd.length > 0 ? <Action.ShowInFinder title="Open Project Folder" path={item.cwd} /> : null}
        <Action
          title="Toggle Details"
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={onToggleDetail}
        />
      </ActionPanel.Section>

      <ActionPanel.Section>
        <Action.CopyToClipboard
          title="Copy Session ID"
          content={item.sessionId}
          shortcut={{ modifiers: ["cmd"], key: "." }}
        />
        <Action.CopyToClipboard
          title="Copy Resume Command"
          content={command()}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        />
        {item.lastPrompt !== null ? (
          <Action.CopyToClipboard title="Copy Last Prompt" content={item.lastPrompt.display} />
        ) : null}
        {item.cwd.length > 0 ? <Action.CopyToClipboard title="Copy Directory Path" content={item.cwd} /> : null}
      </ActionPanel.Section>

      <ActionPanel.Section>
        {item.transcript !== null ? (
          <Action.ShowInFinder title="Show Transcript in Finder" path={item.transcript.path} />
        ) : null}
        {unreachable && item.live !== null ? (
          <Action
            title={`Quit Stale Process (pid ${item.live.pid})`}
            icon={Icon.XMarkCircle}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["ctrl"], key: "x" }}
            onAction={quitStale}
          />
        ) : null}
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
          onAction={onRefresh}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}
