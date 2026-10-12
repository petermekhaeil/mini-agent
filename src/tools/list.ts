import { readdir } from "node:fs/promises";
import path from "node:path";
import { resolveConfinedPath } from "./read";

const MAX_FILES = 200;
const MAX_CHARS = 8_000;
const TRUNCATION_RESERVE = 80;

function parseDirectoryPath(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }

  const requestedPath = (value as Record<string, unknown>).path;
  if (requestedPath === undefined) return ".";
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  return requestedPath;
}

async function collectFiles(
  directory: string,
  root: string,
  files: string[],
): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await collectFiles(fullPath, root, files)) return true;
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath).split(path.sep).join("/"));
      if (files.length > MAX_FILES) return true;
    }
    // Dirent does not follow symlinks, so symlinked directories are skipped.
  }
  return false;
}

function formatFileList(files: string[], morePathsRemain: boolean): string {
  files.sort();
  const visibleFiles = files.slice(0, MAX_FILES);
  const body = visibleFiles.join("\n");
  const pathNote = morePathsRemain ? "\n[truncated; more paths remain]" : "";
  const report = body + pathNote;

  if (report.length <= MAX_CHARS) return report || "(no files found)";

  const keptChars = MAX_CHARS - TRUNCATION_RESERVE;
  const omittedChars = report.length - keptChars;
  const pathSummary = morePathsRemain ? "; more paths remain" : "";
  return `${report.slice(0, keptChars)}\n[truncated ${omittedChars} chars${pathSummary}]`;
}

export async function listFilesTool(
  value: unknown,
  cwd = process.cwd(),
): Promise<string> {
  try {
    const requestedPath = parseDirectoryPath(value);
    const { root, resolved } = await resolveConfinedPath(requestedPath, cwd);
    const files: string[] = [];
    const morePathsRemain = await collectFiles(resolved, root, files);
    return formatFileList(files, morePathsRemain);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}
