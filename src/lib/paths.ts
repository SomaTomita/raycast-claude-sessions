import { homedir } from "node:os";
import { join } from "node:path";

const configuredHome = process.env.CLAUDE_CONFIG_DIR?.trim();

/** Claude Code's config root. Honours CLAUDE_CONFIG_DIR when set. */
export const CLAUDE_HOME = configuredHome && configuredHome.length > 0 ? configuredHome : join(homedir(), ".claude");

/** Live session registry: one `<pid>.json` per running Claude Code process. */
export const REGISTRY_DIR = join(CLAUDE_HOME, "sessions");

/** Transcript store: `<encoded-project-dir>/<sessionId>.jsonl`. */
export const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

/** Global prompt history, newest last. */
export const PROMPT_HISTORY_FILE = join(CLAUDE_HOME, "history.jsonl");

/** True for filesystem errors that just mean "not there / not ours to read". */
export function isMissingOrDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}
