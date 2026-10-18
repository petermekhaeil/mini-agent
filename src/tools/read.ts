import { realpath } from "node:fs/promises";
import path from "node:path";

const MAX_CHARS = 8_000;
const TRUNCATION_RESERVE = 40;

export async function resolveConfinedPath(
  filePath: string,
  cwd = process.cwd(),
): Promise<{ root: string; resolved: string }> {
  const root = await realpath(cwd);
  const resolved = await realpath(path.resolve(root, filePath));
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("path must stay within the working directory");
  }
  return { root, resolved };
}

export async function readConfinedFile(
  filePath: string,
  cwd = process.cwd(),
): Promise<string> {
  const { resolved } = await resolveConfinedPath(filePath, cwd);
  return Bun.file(resolved).text();
}

function limitOutput(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const keptChars = MAX_CHARS - TRUNCATION_RESERVE;
  const omittedChars = text.length - keptChars;
  return `${text.slice(0, keptChars)}\n[truncated ${omittedChars} chars]`;
}

function hasHiddenComponent(relativePath: string): boolean {
  return relativePath.split(path.sep).some(
    (component) => component.length > 1 && component.startsWith("."),
  );
}

function hasUnsafeRawComponent(filePath: string): boolean {
  return filePath.split(/[\\/]/).some(
    (component) => component === ".." || (component.length > 1 && component.startsWith(".")),
  );
}

export async function readFileTool(
  value: unknown,
  cwd = process.cwd(),
): Promise<string> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("arguments must be an object");
    }
    const filePath = (value as Record<string, unknown>).path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    if (hasUnsafeRawComponent(filePath)) {
      throw new Error("hidden files and directories cannot be read");
    }
    const { root, resolved } = await resolveConfinedPath(filePath, cwd);
    const lexicalPath = path.resolve(cwd, filePath);
    const lexicalRelative = path.relative(path.resolve(cwd), lexicalPath);
    const canonicalRelative = path.relative(root, resolved);
    if (
      hasHiddenComponent(lexicalRelative) ||
      hasHiddenComponent(canonicalRelative)
    ) {
      throw new Error("hidden files and directories cannot be read");
    }
    return limitOutput(await Bun.file(resolved).text());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}
