import { isMissingOrDenied, PROMPT_HISTORY_FILE } from "./paths";
import { readTail } from "./tail";

/** Only the tail of the prompt log is read: it grows forever and we want the newest entries. */
const TAIL_BYTES = 1024 * 1024;

export interface PromptEntry {
  readonly display: string;
  readonly timestampMs: number;
  readonly project: string;
}

/**
 * Maps sessionId to that session's most recent prompt, taken from `~/.claude/history.jsonl`.
 * Older sessions may be absent once they scroll out of the tail window.
 */
export async function readRecentPrompts(): Promise<Map<string, PromptEntry>> {
  let text: string;
  try {
    text = await readTail(PROMPT_HISTORY_FILE, TAIL_BYTES);
  } catch (error) {
    if (isMissingOrDenied(error)) {
      return new Map();
    }
    throw error;
  }

  const prompts = new Map<string, PromptEntry>();
  for (const line of text.split("\n")) {
    if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const display = typeof record.display === "string" ? record.display : "";
    if (sessionId.length === 0 || display.length === 0) {
      continue;
    }
    prompts.set(sessionId, {
      display,
      timestampMs: typeof record.timestamp === "number" ? record.timestamp : 0,
      project: typeof record.project === "string" ? record.project : "",
    });
  }

  return prompts;
}
