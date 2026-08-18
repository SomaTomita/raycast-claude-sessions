import { execFile } from "node:child_process";

/** Promisified execFile with a timeout, used for the few CLI calls this extension makes. */
export function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
