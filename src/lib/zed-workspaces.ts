import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { run } from "./run";

/**
 * Zed keeps one macOS window per *set* of workspaces: a single window can hold several projects and
 * only the active one appears in the window title. Window titles therefore cannot answer "is this
 * directory open in Zed", which is what the list needs. Zed's own state database can.
 *
 * This reads an implementation detail of another application, so every failure path is silent and
 * the caller treats an empty result as "unknown", never as "nothing is open".
 */
const DB_CANDIDATES: readonly string[] = ["0-stable", "0-dev", "0-nightly", "0-preview"].map((channel) =>
  join(homedir(), "Library/Application Support/Zed/db", channel, "db.sqlite"),
);

/**
 * Workspaces that belong to a window, restricted to the most recent Zed run plus rows that never
 * recorded a run. Widening rather than narrowing is deliberate: a project wrongly considered open
 * only costs a missing badge, while a project wrongly considered closed mislabels a live session.
 */
const QUERY = `
select paths from workspaces
where window_id is not null
  and paths is not null
  and paths <> ''
  and (
    session_id is null
    or session_id = ''
    or session_id = (select session_id from workspaces where session_id is not null and session_id <> '' order by timestamp desc limit 1)
  );
`.trim();

function databasePath(): string | null {
  return DB_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

/** Absolute project paths currently open in Zed. Empty when the state cannot be read. */
export async function readOpenZedProjects(): Promise<string[]> {
  const database = databasePath();
  if (database === null) {
    return [];
  }

  let stdout: string;
  try {
    stdout = await run("/usr/bin/sqlite3", ["-readonly", "-noheader", database, QUERY]);
  } catch {
    return [];
  }

  // A row can hold several roots for a multi-root workspace.
  return [
    ...new Set(
      stdout
        .split("\n")
        .flatMap((line) => line.split("\n").flatMap((entry) => entry.split(",")))
        .map((path) => path.trim())
        .filter((path) => path.startsWith("/")),
    ),
  ];
}

/** True when `cwd` is one of the open projects, or lives inside one. */
export function isInsideOpenProject(cwd: string, openProjects: readonly string[]): boolean {
  return openProjects.some((project) => cwd === project || cwd.startsWith(`${project}/`));
}
