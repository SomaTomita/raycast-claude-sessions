import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { run } from "./run";

/**
 * Raycast processes inherit a minimal PATH, so a bare `claude` often fails to resolve.
 * These are the install locations Claude Code uses, in order of preference.
 */
const BINARY_CANDIDATES: readonly string[] = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  join(homedir(), ".claude/local/claude"),
  join(homedir(), ".local/bin/claude"),
  join(homedir(), ".bun/bin/claude"),
];

let cachedBinary: string | null = null;

function expandTilde(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the Claude Code binary once per session, falling back to a login shell lookup. */
export async function resolveClaudeBinary(preferred?: string): Promise<string> {
  if (cachedBinary !== null) {
    return cachedBinary;
  }

  const configured = preferred?.trim() ?? "";
  const candidates = [...(configured.includes("/") ? [expandTilde(configured)] : []), ...BINARY_CANDIDATES];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }

  try {
    const found = (await run("/bin/zsh", ["-lic", "which claude"])).trim().split("\n").pop() ?? "";
    if (found.startsWith("/") && (await isExecutable(found))) {
      cachedBinary = found;
      return found;
    }
  } catch {
    // fall through to the error below
  }

  throw new Error(`Claude CLI not found. Searched: ${candidates.join(", ")}`);
}

export async function execClaude(args: readonly string[], preferredBinary?: string): Promise<string> {
  const binary = await resolveClaudeBinary(preferredBinary);
  return run(binary, args);
}
