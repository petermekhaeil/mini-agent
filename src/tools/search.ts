import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveConfinedPath } from "./read";

export const SEARCH_TIMEOUT_MS = 10_000;
const MAX_MATCH_LINES = 100;
const MAX_RESPONSE_CHARS = 8_000;

type SearchArgs = { pattern: string; path?: string; glob?: string };

function parseArgs(value: unknown): SearchArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (typeof args.pattern !== "string" || args.pattern.length === 0) {
    throw new Error("pattern must be a non-empty string");
  }
  if (args.path !== undefined && (typeof args.path !== "string" || args.path.length === 0)) {
    throw new Error("path must be a non-empty string when provided");
  }
  if (args.glob !== undefined && (typeof args.glob !== "string" || args.glob.length === 0)) {
    throw new Error("glob must be a non-empty string when provided");
  }
  return {
    pattern: args.pattern,
    ...(args.path === undefined ? {} : { path: args.path as string }),
    ...(args.glob === undefined ? {} : { glob: args.glob as string }),
  };
}

function limitOutput(output: string): string {
  const lines = output.split("\n");
  const matches = lines.slice(0, MAX_MATCH_LINES);
  const omitted = lines.length > matches.length;
  const lineNote = "[truncated; additional matches omitted]";
  const result = [...matches, ...(omitted ? [lineNote] : [])].join("\n");
  if (result.length <= MAX_RESPONSE_CHARS) return result;

  const limitedMatches = [...matches];
  const charNote = "[truncated; additional matches omitted (8,000 character limit)]";
  while (limitedMatches.length > 0 && `${limitedMatches.join("\n")}\n${charNote}`.length > MAX_RESPONSE_CHARS) {
    limitedMatches.pop();
  }
  return [...limitedMatches, charNote].join("\n");
}

function boundedStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 1_960)}\n[stderr truncated]`;
}

export async function codeSearchTool(value: unknown, cwd = process.cwd()): Promise<string> {
  try {
    const { pattern, path: requestedPath = ".", glob } = parseArgs(value);
    const root = await realpath(cwd);
    const { resolved } = await resolveConfinedPath(requestedPath, root);
    const info = await stat(resolved);
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error("search path must be an existing regular file or directory");
    }
    const relativePath = path.relative(root, resolved) || ".";
    const args = [
      "--no-heading",
      "--line-number",
      "--with-filename",
      "--color",
      "never",
      "--max-columns",
      "300",
      "--max-columns-preview",
      ...(glob === undefined ? [] : ["--glob", glob]),
      "--",
      pattern,
      relativePath,
    ];

    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync(["rg", ...args], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: SEARCH_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "Error: ripgrep (rg) is required for code_search; install ripgrep and ensure rg is on PATH";
      }
      throw error;
    }
    if (result.exitedDueToTimeout) return `Error: ripgrep search timed out after ${SEARCH_TIMEOUT_MS} ms`;
    if (result.exitCode === 1) return "(no matches)";
    if (result.exitCode !== 0) {
      const stderr = boundedStderr(new TextDecoder().decode(result.stderr));
      return `Error: ripgrep failed${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}${stderr ? `: ${stderr}` : ""}`;
    }
    const output = new TextDecoder().decode(result.stdout).replace(/\n$/, "");
    return limitOutput(output);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
