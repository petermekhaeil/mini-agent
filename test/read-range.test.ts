import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "../src/tools/read";

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-read-range-"));
  await writeFile(path.join(cwd, "lines.txt"), "one\r\ntwo\nthree\n");
  await writeFile(path.join(cwd, "large.txt"), Array.from({ length: 1200 }, (_, i) => `line-${i + 1}`).join("\n"));
  await mkdir(path.join(cwd, ".hidden"));
  await writeFile(path.join(cwd, ".hidden", "secret.txt"), "secret");
  await symlink(path.join(cwd, ".hidden", "secret.txt"), path.join(cwd, "secret-link.txt"));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("read_file line ranges", () => {
  test("keeps raw full-text behavior when range options are absent", async () => {
    expect(await readFileTool({ path: "lines.txt" }, cwd)).toBe("one\r\ntwo\nthree\n");
  });

  test("returns numbered first, middle, and EOF ranges preserving line endings", async () => {
    expect(await readFileTool({ path: "lines.txt", limit: 1 }, cwd)).toBe("1: one\r\n");
    expect(await readFileTool({ path: "lines.txt", offset: 2, limit: 1 }, cwd)).toBe("2: two\n");
    expect(await readFileTool({ path: "lines.txt", offset: 3 }, cwd)).toBe("3: three\n");
  });

  test("reports a range beginning beyond EOF", async () => {
    expect(await readFileTool({ path: "lines.txt", offset: 4 }, cwd)).toBe(
      "Error: offset 4 is beyond end of file (3 lines)",
    );
  });

  test("caps large ranged and un-ranged output", async () => {
    const full = await readFileTool({ path: "large.txt" }, cwd);
    const range = await readFileTool({ path: "large.txt", offset: 1 }, cwd);
    expect(full.length).toBeLessThanOrEqual(8_000);
    expect(range.length).toBeLessThanOrEqual(8_000);
    expect(full).toContain("[truncated ");
    expect(range).toContain("[truncated ");
  });

  test("rejects invalid range values before reading", async () => {
    for (const value of [0, -1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await readFileTool({ path: "missing.txt", offset: value }, cwd);
      expect(result).toMatch(/^Error: offset must be a positive integer$/);
    }
    expect(await readFileTool({ path: "missing.txt", limit: 0 }, cwd)).toBe(
      "Error: limit must be a positive integer",
    );
  });

  test("retains hidden-file and symlink confinement", async () => {
    expect(await readFileTool({ path: ".hidden/secret.txt", offset: 1 }, cwd)).toMatch(/^Error: hidden files/);
    expect(await readFileTool({ path: "secret-link.txt", offset: 1 }, cwd)).toMatch(/^Error: hidden files/);
  });
});
