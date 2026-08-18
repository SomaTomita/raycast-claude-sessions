import { isMissingOrDenied } from "./paths";
import { readTail } from "./tail";

/** How much of the transcript tail to parse for the conversation preview. */
const TAIL_BYTES = 768 * 1024;

export interface TranscriptMessage {
  readonly role: "user" | "claude";
  readonly text: string;
  readonly timestampMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Flattens `message.content` into plain text, dropping tool traffic and thinking blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asRecord(block);
      return record !== null && record.type === "text" ? str(record.text) : "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

/**
 * Returns the last `limit` real turns of a conversation, oldest first.
 * Only the tail of the file is read, so this stays cheap on multi-megabyte transcripts.
 */
export async function readRecentMessages(path: string, limit: number): Promise<TranscriptMessage[]> {
  let text: string;
  try {
    text = await readTail(path, TAIL_BYTES);
  } catch (error) {
    if (isMissingOrDenied(error)) {
      return [];
    }
    throw error;
  }

  const collected: TranscriptMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) {
      continue;
    }
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) {
      continue;
    }
    if (line.includes('"isSidechain":true')) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === null || record.isMeta === true) {
      continue;
    }

    const body = contentText(asRecord(record.message)?.content).trim();
    if (body.length === 0) {
      continue;
    }

    const stamp = Date.parse(str(record.timestamp));
    collected.push({
      role: record.type === "assistant" ? "claude" : "user",
      text: body,
      timestampMs: Number.isFinite(stamp) ? stamp : null,
    });
  }

  return collected.slice(-limit);
}
