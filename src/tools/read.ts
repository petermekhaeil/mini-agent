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

function validateRangeOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function splitLines(text: string): Array<{ text: string; ending: string }> {
  const lines: Array<{ text: string; ending: string }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    const ending = text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : text[index];
    lines.push({ text: text.slice(start, index), ending });
    if (ending.length === 2) index++;
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

function formatRange(text: string, offset: number, limit: number | undefined): string {
  const lines = splitLines(text);
  if (offset > lines.length) {
    throw new Error(`offset ${offset} is beyond end of file (${lines.length} lines)`);
  }
  const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
  return selected.map((line, index) => `${offset + index}: ${line.text}${line.ending}`).join("");
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
    const options = value as Record<string, unknown>;
    const offset = validateRangeOption(options.offset, "offset");
    const limit = validateRangeOption(options.limit, "limit");
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
    const text = await Bun.file(resolved).text();
    if (offset === undefined && limit === undefined) return limitOutput(text);
    return limitOutput(formatRange(text, offset ?? 1, limit));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}
