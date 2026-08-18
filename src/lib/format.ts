import { homedir } from "node:os";

const COMMAND_TAG = /<\/?(local-command-stdout|local-command-caveat|command-name|command-message|command-args|system-reminder)>/g;
const XML_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Turns a raw prompt into a single readable line for list titles. */
export function cleanPrompt(text: string, maxLength = 120): string {
  const flattened = text
    .replace(XML_BLOCK, " ")
    .replace(COMMAND_TAG, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

/** Last path segment of the working directory, falling back to the encoded project slug. */
export function projectName(cwd: string, projectSlug: string): string {
  const fromCwd = cwd.split("/").filter((part) => part.length > 0).pop();
  if (fromCwd !== undefined && fromCwd.length > 0) {
    return fromCwd;
  }
  const fromSlug = projectSlug.split("-").filter((part) => part.length > 0).pop();
  return fromSlug ?? projectSlug;
}

/** `/Users/<name>/Documents/x` -> `~/Documents/x`, so full paths fit in a list row. */
export function formatHomePath(path: string): string {
  if (path.length === 0) {
    return "";
  }
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatAbsolute(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  return new Date(ms).toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
