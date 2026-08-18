/** Asks a session's process to exit. SIGTERM lets Claude Code shut down and flush its transcript. */
export function quitProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to signal pid ${pid}`);
  }
  process.kill(pid, "SIGTERM");
}
