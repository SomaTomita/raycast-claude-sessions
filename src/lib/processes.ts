import { run } from "./run";

/**
 * How far the process start may sit from the session's own `startedAt`.
 * Claude Code writes `startedAt` a few seconds into its boot, and `etime` has one second of
 * granularity, so the window only has to be tight enough to catch a reused pid.
 */
const START_TOLERANCE_MS = 180_000;

/** `ps -o etime=` prints `[[dd-]hh:]mm:ss`, and unlike `lstart` it is free of locale and timezone. */
const ELAPSED = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;

function parseElapsedSeconds(etime: string): number | null {
  const match = ELAPSED.exec(etime.trim());
  if (match === null) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

/**
 * Asks a session's process to exit. SIGTERM lets Claude Code shut down and flush its transcript.
 *
 * The process identity is verified first: `isAlive` treats EPERM as alive, so a stale registry file
 * whose pid has been reused points at somebody else's process, and signalling it would be wrong.
 * `ps -o lstart=` cannot be compared directly (the registry records UTC, `ps` prints local time in
 * the current locale), so the check runs on elapsed time instead.
 */
export async function quitProcess(pid: number, startedAt: number | null): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to signal pid ${pid}`);
  }

  if (startedAt !== null) {
    let elapsedRaw: string;
    try {
      elapsedRaw = await run("/bin/ps", ["-o", "etime=", "-p", String(pid)]);
    } catch {
      throw new Error(`pid ${pid} is no longer running`);
    }

    const elapsed = parseElapsedSeconds(elapsedRaw);
    if (elapsed === null) {
      throw new Error(`Could not confirm what pid ${pid} is (ps reported ${elapsedRaw.trim()})`);
    }

    const processStart = Date.now() - elapsed * 1_000;
    if (Math.abs(processStart - startedAt) > START_TOLERANCE_MS) {
      throw new Error(
        `pid ${pid} now belongs to a different process (running for ${elapsed}s, session started ${new Date(startedAt).toLocaleString()})`,
      );
    }
  }

  process.kill(pid, "SIGTERM");
}
