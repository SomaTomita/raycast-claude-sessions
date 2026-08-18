import { Color, Icon, List } from "@raycast/api";

import { cleanPrompt, formatAbsolute, formatBytes, formatDuration, formatHomePath } from "../lib/format";
import { TranscriptMessage } from "../lib/messages";
import { SessionItem } from "../lib/sessions";

const STATE_COLOR = {
  working: Color.Green,
  waiting: Color.Blue,
  closed: Color.SecondaryText,
} as const;

/** Per-turn budget in the narrow pane. Long turns get an ellipsis rather than a wall of text. */
const TURN_LENGTH = 260;

interface Props {
  readonly item: SessionItem;
  readonly messages: readonly TranscriptMessage[];
  readonly isLoadingMessages: boolean;
}

function turn(message: TranscriptMessage): string {
  return `\`${message.role}\` ${cleanPrompt(message.text, TURN_LENGTH)}`;
}

/** The pane is tall and the metadata short, so the conversation fills the space instead of blank air. */
function markdown({ item, messages, isLoadingMessages }: Props): string {
  const title = `**${item.title}**`;

  if (messages.length > 0) {
    return [title, ...messages.map(turn)].join("\n\n");
  }
  if (isLoadingMessages) {
    return `${title}\n\n\`reading transcript…\``;
  }

  const prompt = cleanPrompt(item.lastPrompt?.display ?? item.transcript?.firstPrompt ?? "", 1200);
  if (prompt.length === 0) {
    return `${title}\n\n\`no prompt recorded\``;
  }
  return `${title}\n\n\`${item.lastPrompt !== null ? "last prompt" : "first prompt"}\` ${prompt}`;
}

function hostText(item: SessionItem): string {
  const live = item.live;
  if (live === null) {
    return "—";
  }
  const app = live.hostApp.length > 0 ? live.hostApp : "unknown";
  return live.tty.length > 0 ? `${app} · ${live.tty}` : app;
}

export function SessionDetail(props: Props) {
  const { item } = props;
  const live = item.live;
  const uptime = live?.startedAt != null ? formatDuration(Date.now() - live.startedAt) : "—";

  return (
    <List.Item.Detail
      markdown={markdown(props)}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.TagList title="Status">
            <List.Item.Detail.Metadata.TagList.Item text={item.statusLabel} color={STATE_COLOR[item.state]} />
          </List.Item.Detail.Metadata.TagList>
          <List.Item.Detail.Metadata.Label
            title="Opened in"
            text={item.cwd.length > 0 ? formatHomePath(item.cwd) : "—"}
            icon={Icon.Folder}
          />
          {item.gitBranch.length > 0 ? (
            <List.Item.Detail.Metadata.Label title="Branch" text={item.gitBranch} icon={Icon.CodeBlock} />
          ) : null}
          <List.Item.Detail.Metadata.Label title="Last activity" text={formatAbsolute(item.lastActivityMs)} />
          {live !== null ? (
            <>
              <List.Item.Detail.Metadata.Label title="Host" text={hostText(item)} icon={Icon.AppWindow} />
              <List.Item.Detail.Metadata.Label title="Session" text={`${live.name} · pid ${live.pid} · up ${uptime}`} />
            </>
          ) : null}
          <List.Item.Detail.Metadata.Label
            title="Transcript"
            text={[
              item.model.length > 0 ? item.model : "unknown model",
              item.messageCount === null ? null : `${item.messageCount}${item.messageCountExact ? "" : "+"} msg`,
              item.transcript === null ? null : formatBytes(item.transcript.sizeBytes),
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          />
          <List.Item.Detail.Metadata.Label title="Session ID" text={item.sessionId} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}
