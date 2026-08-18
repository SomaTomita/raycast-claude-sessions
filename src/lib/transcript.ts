import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { mapWithConcurrency } from "./async";
import { isMissingOrDenied, PROJECTS_DIR } from "./paths";

/** Streaming chunk size. Keeps peak memory flat regardless of transcript size. */
const CHUNK_BYTES = 256 * 1024;
/** Hard stop for pathological transcripts; beyond this the summary is a lower bound. */
const MAX_SCAN_BYTES = 40 * 1024 * 1024;
/** Cap on candidate `user` records inspected while hunting for the opening prompt. */
const FIRST_PROMPT_SCAN_LIMIT = 200;
/** Transcripts read in parallel. */
const SCAN_CONCURRENCY = 4;

export interface TranscriptFile {
  readonly sessionId: string;
  readonly path: string;
  readonly projectSlug: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

export interface TranscriptSummary extends TranscriptFile {
  readonly cwd: string;
  readonly gitBranch: string;
  readonly version: string;
  readonly aiTitle: string;
  readonly firstPrompt: string;
  readonly model: string;
  readonly messageCount: number;
  /** false when scanning stopped early, making messageCount a lower bound. */
  readonly messageCountExact: boolean;
  readonly lastTimestampMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseLine(line: string): Record<string, unknown> | null {
  if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) {
    return null;
  }
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestampMs(value: unknown): number | null {
  const parsed = Date.parse(str(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Flattens `message.content` (string or content-block array) into plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asRecord(block);
      return record !== null && record.type === "text" ? str(record.text) : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Lists every transcript on disk, newest first. Cheap: readdir + stat only. */
export async function indexTranscripts(): Promise<TranscriptFile[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingOrDenied(error)) {
      return [];
    }
    throw error;
  }

  const perProject = await mapWithConcurrency(projectDirs, 8, async (projectSlug) => {
    let names: string[];
    try {
      names = (await readdir(join(PROJECTS_DIR, projectSlug))).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
      if (isMissingOrDenied(error)) {
        return [];
      }
      throw error;
    }

    const files = await Promise.all(
      names.map(async (name) => {
        const path = join(PROJECTS_DIR, projectSlug, name);
        try {
          const stats = await stat(path);
          if (stats.size === 0) {
            return null;
          }
          return {
            sessionId: basename(name, ".jsonl"),
            path,
            projectSlug,
            mtimeMs: stats.mtimeMs,
            sizeBytes: stats.size,
          };
        } catch (error) {
          if (isMissingOrDenied(error)) {
            return null;
          }
          throw error;
        }
      }),
    );

    return files.filter((file): file is TranscriptFile => file !== null);
  });

  return perProject.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Feeds `onLine` one line at a time. Never holds more than a chunk plus one line. */
async function forEachLine(path: string, onLine: (line: string) => void): Promise<boolean> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: CHUNK_BYTES });
  let carry = "";
  let consumed = 0;
  let truncated = false;

  try {
    for await (const chunk of stream) {
      consumed += (chunk as string).length;
      let text = carry + (chunk as string);
      let start = 0;
      let index = text.indexOf("\n", start);
      while (index !== -1) {
        onLine(text.slice(start, index));
        start = index + 1;
        index = text.indexOf("\n", start);
      }
      carry = text.slice(start);
      text = "";
      if (consumed >= MAX_SCAN_BYTES) {
        truncated = true;
        break;
      }
    }
  } finally {
    stream.destroy();
  }

  if (!truncated && carry.length > 0) {
    onLine(carry);
  }
  return truncated;
}

/** Reads one transcript and pulls out the fields the list needs. Tolerates malformed lines. */
export async function summarizeTranscript(file: TranscriptFile): Promise<TranscriptSummary> {
  let aiTitle = "";
  let cwd = "";
  let gitBranch = "";
  let version = "";
  let firstPrompt = "";
  let promptCandidates = 0;
  let messages = 0;
  let model = "";
  let lastTimestampMs: number | null = null;

  const onLine = (line: string): void => {
    if (line.length === 0) {
      return;
    }
    const isSidechain = line.includes('"isSidechain":true');

    if (aiTitle.length === 0 && line.includes('"ai-title"')) {
      aiTitle = str(parseLine(line)?.aiTitle);
    }

    if (cwd.length === 0 && line.includes('"cwd"')) {
      const record = parseLine(line);
      if (record !== null) {
        cwd = str(record.cwd);
        gitBranch = str(record.gitBranch);
        version = str(record.version);
      }
    }

    if (line.includes('"type":"user"')) {
      if (!isSidechain) {
        messages += 1;
      }
      if (firstPrompt.length === 0 && !isSidechain && promptCandidates < FIRST_PROMPT_SCAN_LIMIT) {
        promptCandidates += 1;
        const record = parseLine(line);
        const message = asRecord(record?.message);
        if (record !== null && record.isMeta !== true && message !== null) {
          firstPrompt = contentText(message.content).trim().slice(0, 400);
        }
      }
    } else if (line.includes('"type":"assistant"') && !isSidechain) {
      messages += 1;
      const parsedModel = str(asRecord(parseLine(line)?.message)?.model);
      if (parsedModel.length > 0) {
        model = parsedModel;
      }
    }

    if (line.includes('"timestamp":"')) {
      lastTimestampMs = timestampMs(parseLine(line)?.timestamp) ?? lastTimestampMs;
    }
  };

  let truncated = false;
  try {
    truncated = await forEachLine(file.path, onLine);
  } catch (error) {
    if (!isMissingOrDenied(error)) {
      throw error;
    }
  }

  return {
    ...file,
    cwd,
    gitBranch,
    version,
    aiTitle,
    firstPrompt,
    model,
    messageCount: messages,
    messageCountExact: !truncated,
    lastTimestampMs,
  };
}

const summaryCache = new Map<string, { readonly mtimeMs: number; readonly summary: TranscriptSummary }>();

/** Memoised per path+mtime: re-reading unchanged transcripts on every refresh is the slow part. */
export async function summarizeTranscriptCached(file: TranscriptFile): Promise<TranscriptSummary> {
  const cached = summaryCache.get(file.path);
  if (cached !== undefined && cached.mtimeMs === file.mtimeMs) {
    return cached.summary;
  }
  const summary = await summarizeTranscript(file);
  summaryCache.set(file.path, { mtimeMs: file.mtimeMs, summary });
  return summary;
}

/** Summarises many transcripts without blowing the extension's memory cap. */
export async function summarizeAll(files: readonly TranscriptFile[]): Promise<TranscriptSummary[]> {
  return mapWithConcurrency(files, SCAN_CONCURRENCY, summarizeTranscriptCached);
}
