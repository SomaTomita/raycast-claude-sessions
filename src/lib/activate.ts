import { run } from "./run";

/**
 * Brings the application instance owning `pid` to the front.
 *
 * `tell application "X" to activate` resolves by name, which launches the app when it is not
 * running and cannot tell two instances of one bundle apart. NSRunningApplication targets the
 * exact process, switches Spaces (fullscreen included), and never launches anything. It throws
 * for a process with no GUI, which is how a session inside tmux or over ssh is detected.
 */
export async function activateProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to activate pid ${pid}`);
  }
  const script = `ObjC.import("AppKit");
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(parseInt(argv[0], 10));
  if (app.isNil()) throw new Error("no GUI app with pid " + argv[0]);
  app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
}`;
  await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, String(pid)]);
}
