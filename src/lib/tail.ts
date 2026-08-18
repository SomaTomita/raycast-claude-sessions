import { open, stat } from "node:fs/promises";

/** Reads the last `bytes` of a file as UTF-8. The first line may be cut mid-character. */
export async function readTail(path: string, bytes: number): Promise<string> {
  const stats = await stat(path);
  const length = Math.min(bytes, stats.size);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
