import { Detail } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";

import { formatAbsolute, formatHomePath } from "../lib/format";
import { readRecentMessages, TranscriptMessage } from "../lib/messages";
import { SessionItem } from "../lib/sessions";

/** Turns shown in the full-width view, and how much of each. */
const TURN_COUNT = 40;
const TURN_LENGTH = 2_000;

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function turn(message: TranscriptMessage): string {
  const stamp = message.timestampMs === null ? "" : ` · ${new Date(message.timestampMs).toLocaleTimeString()}`;
  return `**${message.role}**${stamp}\n\n${clamp(message.text, TURN_LENGTH)}`;
}

/** Full-width conversation view. The list's detail pane is fixed at roughly a third of the window. */
export function TranscriptView({ item }: { item: SessionItem }) {
  const path = item.transcript?.path ?? "";
  const { data, isLoading } = useCachedPromise(
    (target: string) => (target.length === 0 ? Promise.resolve([]) : readRecentMessages(target, TURN_COUNT)),
    [path],
    { initialData: [] as TranscriptMessage[], keepPreviousData: true },
  );

  const header = [
    `# ${item.title}`,
    [
      item.statusLabel,
      item.cwd.length > 0 ? formatHomePath(item.cwd) : null,
      item.gitBranch.length > 0 ? item.gitBranch : null,
      item.model.length > 0 ? item.model : null,
      formatAbsolute(item.lastActivityMs),
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  ].join("\n\n");

  const body =
    data.length > 0
      ? data.map(turn).join("\n\n---\n\n")
      : isLoading
        ? "_reading transcript…_"
        : "_no messages found in this transcript_";

  return <Detail navigationTitle={item.title} isLoading={isLoading} markdown={`${header}\n\n---\n\n${body}`} />;
}
