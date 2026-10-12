import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolveConfinedPath } from "./read";

export type ConfirmEdit = (absoluteTarget: string, oldStr: string, newStr: string) => Promise<boolean>;

type EditArgs = { path: string; old_str: string; new_str: string };

function parseArgs(value: unknown): EditArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (typeof args.path !== "string" || args.path.length === 0) throw new Error("path must be a non-empty string");
  if (typeof args.old_str !== "string" || args.old_str.length === 0) throw new Error("old_str must be a non-empty string");
  if (typeof args.new_str !== "string") throw new Error("new_str must be a string");
  return { path: args.path, old_str: args.old_str, new_str: args.new_str };
}

export async function editFileTool(
  value: unknown,
  cwd = process.cwd(),
  confirm: ConfirmEdit = async () => false,
): Promise<string> {
  try {
    const { path: filePath, old_str: oldStr, new_str: newStr } = parseArgs(value);
    for (const text of [oldStr, newStr]) {
      if (Buffer.from(text, "utf8").toString("utf8") !== text) {
        throw new Error("old_str and new_str must contain valid Unicode text");
      }
    }

    const root = await realpath(cwd);
    const { resolved: target } = await resolveConfinedPath(filePath, root);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("target must be a regular file");

    const originalBytes = await readFile(target);
    let originalText: string;
    try {
      originalText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(originalBytes);
    } catch {
      throw new Error("target is not valid UTF-8 text");
    }
    if (!Buffer.from(originalText, "utf8").equals(originalBytes)) {
      throw new Error("target is not valid UTF-8 text");
    }

    const first = originalText.indexOf(oldStr);
    if (first < 0) throw new Error("old_str was not found");
    if (originalText.indexOf(oldStr, first + 1) >= 0) throw new Error("old_str must occur exactly once");

    if ((await confirm(target, oldStr, newStr)) !== true) {
      return "Edit denied; the file was not changed. Do not retry without user approval.";
    }

    await writeFile(
      target,
      originalText.slice(0, first) + newStr + originalText.slice(first + oldStr.length),
      "utf8",
    );
    return `Updated ${target}.`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
