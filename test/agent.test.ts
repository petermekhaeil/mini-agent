import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { runAgent } from "../src/loop";
import { createChatClient, type ChatClient } from "../src/llm";
import { listFilesTool } from "../src/tools/list";
import { readFileTool } from "../src/tools/read";
import { bashTool } from "../src/tools/bash";
import { confirmBash } from "../src/cli";

const temporaryDirectories: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function mockCompletion(
  message: ChatCompletion["choices"][number]["message"],
): ChatCompletion {
  return {
    id: "test-completion",
    created: 0,
    model: "test-model",
    object: "chat.completion",
    choices: [
      {
        finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
        index: 0,
        logprobs: null,
        message,
      },
    ],
  };
}

function mockClient(
  responses: ChatCompletion[],
  onRequest?: (request: ChatCompletionCreateParamsNonStreaming) => void,
): ChatClient {
  return {
    chat: {
      completions: {
        create: async (request) => {
          onRequest?.(request);
          const response = responses.shift();
          if (!response) throw new Error("No mock response configured");
          return response;
        },
      },
    },
  };
}

describe("agent tool round-trip", () => {
  test("sends a matching read_file result and keeps the full assistant tool call", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "note.txt"), "hello\nworld\n");
    await writeFile(path.join(cwd, "AGENT.md"), "Prefer concise explanations.");
    const assistantToolCall = {
      role: "assistant" as const,
      content: null,
      refusal: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function" as const,
          function: {
            name: "read_file",
            arguments: '{"path":"note.txt"}',
          },
        },
        {
          id: "call_list",
          type: "function" as const,
          function: {
            name: "list_files",
            arguments: '{"path":"."}',
          },
        },
      ],
    };
    const calls: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = mockClient(
      [
        mockCompletion(assistantToolCall),
        mockCompletion({
          role: "assistant",
          content: "It says hello and world.",
          refusal: null,
        }),
      ],
      (request) => calls.push(structuredClone(request)),
    );

    const result = await runAgent(client, "test-model", "Read note.txt", cwd);
    expect(result.answer).toBe("It says hello and world.");
    expect(calls[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Prefer concise explanations."),
    });
    expect(calls[0].messages[1]).toEqual({
      role: "user",
      content: "Read note.txt",
    });
    expect(result.messages[2]).toEqual(assistantToolCall);
    expect(calls[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_list",
      content: "AGENT.md\nnote.txt",
    });
    expect(calls[1].messages.at(-2)).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "hello\nworld\n",
    });
    expect(calls[1].messages[2]).toEqual(assistantToolCall);
  });

  test("turns malformed arguments and missing files into tool results", async () => {
    const cwd = await tempDir();
    const client = mockClient([
      mockCompletion({
        role: "assistant",
        tool_calls: [
          {
            id: "bad",
            type: "function",
            function: { name: "read_file", arguments: "{" },
          },
          {
            id: "missing",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"absent"}',
            },
          },
          {
            id: "no-path",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
          {
            id: "null",
            type: "function",
            function: { name: "read_file", arguments: "null" },
          },
          {
            id: "bad-list-path",
            type: "function",
            function: { name: "list_files", arguments: '{"path":7}' },
          },
        ],
        content: null,
        refusal: null,
      }),
      mockCompletion({ role: "assistant", content: "Done", refusal: null }),
    ]);
    const result = await runAgent(client, "test-model", "Read files", cwd);
    expect(result.messages[3].content).toStartWith("Error:");
    expect(result.messages[4].content).toStartWith("Error:");
    expect(result.messages[5].content).toStartWith("Error:");
    expect(result.messages[6].content).toStartWith("Error:");
    expect(result.messages[7].content).toStartWith("Error:");
    expect(result.messages[3]).toMatchObject({ role: "tool", tool_call_id: "bad" });
    expect(result.messages[4]).toMatchObject({ role: "tool", tool_call_id: "missing" });
    expect(result.messages[5]).toMatchObject({ role: "tool", tool_call_id: "no-path" });
    expect(result.messages[6]).toMatchObject({ role: "tool", tool_call_id: "null" });
    expect(result.messages[7]).toMatchObject({ role: "tool", tool_call_id: "bad-list-path" });
  });

  test("executes sequential bash calls with separate confirmations and matching IDs", async () => {
    const cwd = await tempDir();
    const calls: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = mockClient([
      mockCompletion({
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: ["one", "two"].map((id, index) => ({
          id: `bash-${id}`,
          type: "function" as const,
          function: { name: "bash", arguments: JSON.stringify({ command: `printf ${index + 1}` }) },
        })),
      }),
      mockCompletion({ role: "assistant", content: "done", refusal: null }),
    ], (request) => calls.push(structuredClone(request)));
    const confirmations: Array<[string, string]> = [];
    const result = await runAgent(client, "test-model", "run commands", cwd, 25, async (command, dir) => {
      confirmations.push([command, dir]);
      return true;
    });
    expect(confirmations).toEqual([["printf 1", cwd], ["printf 2", cwd]]);
    expect(calls[1].messages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "bash-one" });
    expect(calls[1].messages.at(-2)?.content).toContain("stdout:\n1");
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "bash-two" });
    expect(calls[1].messages.at(-1)?.content).toContain("stdout:\n2");
    expect(result.answer).toBe("done");
  });
});

describe("bash", () => {
  test("defaults to denial and explicit denial never creates a sentinel", async () => {
    const cwd = await tempDir();
    const sentinel = path.join(cwd, "sentinel");
    const command = `touch ${JSON.stringify(sentinel)}`;
    expect(await bashTool({ command }, cwd)).toContain("denied");
    expect(await bashTool({ command }, cwd, async () => false)).toContain("denied");
    expect(await Bun.file(sentinel).exists()).toBe(false);
  });

  test("approval rejection returns a result without spawning", async () => {
    const cwd = await tempDir();
    const result = await bashTool({ command: "true" }, cwd, async () => { throw new Error("no prompt"); });
    expect(result).toContain("approval failed: no prompt");
  });

  test("approval executes the exact command in cwd and reports nonzero stderr", async () => {
    const cwd = await tempDir();
    const command = "printf '%s' \"$PWD\"; printf 'bad' >&2; exit 7";
    const result = await bashTool({ command }, cwd, async (approvedCommand, approvedCwd) => {
      expect(approvedCommand).toBe(command);
      expect(approvedCwd).toBe(cwd);
      return true;
    });
    expect(result).toContain(`stdout:\n${await realpath(cwd)}`);
    expect(result).toContain("stderr:\nbad");
    expect(result).toContain("Exit code: 7.");
  });

  test("reports signal termination separately from a timeout", async () => {
    const cwd = await tempDir();
    const result = await bashTool({ command: "kill -TERM $$" }, cwd, async () => true);
    expect(result).toContain("Terminated by signal SIGTERM.");
    expect(result).not.toContain("Timed out");
  });

  test("resolves relative cwd before approval even if the callback changes process.cwd", async () => {
    const original = process.cwd();
    const elsewhere = await tempDir();
    try {
      const result = await bashTool({ command: "pwd" }, ".", async (_command, approvedCwd) => {
        expect(approvedCwd).toBe(original);
        process.chdir(elsewhere);
        return true;
      });
      expect(result).toContain(`stdout:\n${await realpath(original)}`);
    } finally {
      process.chdir(original);
    }
  });

  test("SIGKILLs a shell that ignores TERM after timeout", async () => {
    const cwd = await tempDir();
    const pidFile = path.join(cwd, "shell.pid");
    const result = await bashTool(
      { command: `trap '' TERM; printf '%s' "$$" > ${JSON.stringify(pidFile)}; while :; do sleep 1; done` },
      cwd,
      async () => true,
      40,
    );
    expect(result).toContain("Timed out after 40 ms (SIGKILL).");
    const pid = Number(await Bun.file(pidFile).text());
    let exited = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch { exited = true; break; }
      await Bun.sleep(10);
    }
    expect(exited).toBe(true);
  });

  test("caps returned output after capturing stdout and stderr", async () => {
    const cwd = await tempDir();
    const result = await bashTool(
      { command: "head -c 10000 /dev/zero | tr '\\0' x; head -c 10000 /dev/zero | tr '\\0' y >&2" },
      cwd,
      async () => true,
    );
    expect(result.length).toBeLessThanOrEqual(8_000);
    expect(result).toContain("stdout:");
    expect(result).toContain("stderr:");
    expect(result).toMatch(/\[truncated \d+ chars\]/);
    expect(result).toContain("Exit code: 0.");
    const omitted = Number(result.match(/\[truncated (\d+) chars\]/)?.[1]);
    expect(omitted).toBeGreaterThan(10_000);
  });

  test("malformed arguments never request approval", async () => {
    const cwd = await tempDir();
    let confirmations = 0;
    for (const args of ["not an object", null, {}, { command: 4 }, { command: "  " }]) {
      const result = await bashTool(args, cwd, async () => { confirmations++; return true; });
      expect(result).toStartWith("Error:");
    }
    expect(confirmations).toBe(0);
  });
});

describe("CLI bash confirmation", () => {
  function ttyPair() {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    Object.defineProperty(input, "isTTY", { value: true });
    Object.defineProperty(output, "isTTY", { value: true });
    return { input, output };
  }

  test("settles false on input close instead of leaving approval pending", async () => {
    const { input, output } = ttyPair();
    const pending = confirmBash(
      "touch sentinel",
      "/work",
      input as unknown as typeof process.stdin,
      output as unknown as typeof process.stderr,
    );
    input.destroy();
    expect(await pending).toBe(false);
    output.destroy();
  });

  test("accepts only y or Y", async () => {
    for (const [reply, expected] of [["y\n", true], ["Y\n", true], ["yes\n", false], ["\n", false]] as const) {
      const { input, output } = ttyPair();
      const pending = confirmBash("pwd", "/work", input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
      input.write(reply);
      expect(await pending).toBe(expected);
      input.destroy();
      output.destroy();
    }
  });

  test("denies non-interactive input without waiting for a reply", async () => {
    const input = new PassThrough();
    const { output } = ttyPair();
    input.write("y\n");
    expect(await confirmBash("pwd", "/work", input as unknown as typeof process.stdin, output as unknown as typeof process.stderr)).toBe(false);
    input.destroy();
    output.destroy();
  });

  test("settles false on input EOF", async () => {
    const { input, output } = ttyPair();
    const pending = confirmBash("pwd", "/work", input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
    input.end();
    expect(await pending).toBe(false);
    output.destroy();
  });

  test("settles false on Ctrl-C", async () => {
    const { input, output } = ttyPair();
    const pending = confirmBash(
      "touch sentinel",
      "/work",
      input as unknown as typeof process.stdin,
      output as unknown as typeof process.stderr,
    );
    input.emit("keypress", "\u0003", { ctrl: true, name: "c" });
    expect(await pending).toBe(false);
    input.destroy();
    output.destroy();
  });
});

describe("OpenAI configuration", () => {
  test("requires an API key and accepts an optional model override", () => {
    expect(() => createChatClient({})).toThrow("OPENAI_API_KEY is required");
    const defaultConfig = createChatClient({ OPENAI_API_KEY: "test-key" });
    expect(defaultConfig.client.apiKey).toBe("test-key");
    expect(defaultConfig.model).toBe("gpt-4o-mini");
    expect(
      createChatClient({
        OPENAI_API_KEY: "test-key",
        AGENT_MODEL: "test-model",
      }).model,
    ).toBe("test-model");
  });
});

describe("read_file", () => {
  test("returns raw file text unchanged", async () => {
    const cwd = await tempDir();
    const contents = "first line\nsecond line\n";
    await writeFile(path.join(cwd, "note.txt"), contents);
    expect(await readFileTool({ path: "note.txt" }, cwd)).toBe(contents);
  });

  test("caps even a single huge line and reports omitted characters", async () => {
    const cwd = await tempDir();
    const hugeLine = "x".repeat(20_000);
    await writeFile(path.join(cwd, "huge.txt"), hugeLine);
    const result = await readFileTool({ path: "huge.txt" }, cwd);
    expect(result.length).toBeLessThanOrEqual(8_000);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result).toMatch(/\n\[truncated \d+ chars\]$/);
    const markerIndex = result.lastIndexOf("\n[truncated ");
    const keptText = result.slice(0, markerIndex);
    const omitted = Number(result.match(/\[truncated (\d+) chars\]$/)?.[1]);
    expect(omitted).toBe(hugeLine.length - keptText.length);
  });

  test("rejects paths escaping via traversal or symlink", async () => {
    const parent = await tempDir();
    const cwd = path.join(parent, "work");
    await mkdir(cwd);
    const secret = "outside secret content";
    await writeFile(path.join(parent, "secret.txt"), secret);
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await mkdir(path.join(cwd, "nested"));
    await symlink(path.join(outside, "secret.txt"), path.join(cwd, "nested", "escape"));

    const traversal = await readFileTool({ path: "../secret.txt" }, cwd);
    expect(traversal).toStartWith("Error:");
    expect(traversal).not.toContain(secret);
    expect(await readFileTool({ path: "nested/escape" }, cwd)).toContain(
      "working directory",
    );
  });
});

describe("list_files", () => {
  test("defaults to cwd, sorts paths, prunes generated directories, and skips symlinks", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await mkdir(path.join(cwd, "src"));
    await mkdir(path.join(cwd, ".git"));
    await mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(cwd, "README.md"), "readme");
    await writeFile(path.join(cwd, "src", "main.ts"), "main");
    await writeFile(path.join(cwd, ".git", "config"), "git data");
    await writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "package");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(cwd, "linked"));

    expect(await listFilesTool({}, cwd)).toBe("README.md\nsrc/main.ts");
  });

  test("returns directory and confinement failures as tool results", async () => {
    const parent = await tempDir();
    const cwd = path.join(parent, "work");
    const outside = path.join(parent, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await writeFile(path.join(cwd, "file.txt"), "inside");
    await writeFile(path.join(outside, "secret.txt"), "outside secret");
    await symlink(outside, path.join(cwd, "escape"));

    const traversal = await listFilesTool({ path: "../outside" }, cwd);
    const symlinkEscape = await listFilesTool({ path: "escape" }, cwd);
    const missingDirectory = await listFilesTool({ path: "missing" }, cwd);
    const fileInsteadOfDirectory = await listFilesTool({ path: "file.txt" }, cwd);
    expect(traversal).toStartWith("Error:");
    expect(traversal).not.toContain("outside secret");
    expect(symlinkEscape).toStartWith("Error:");
    expect(symlinkEscape).not.toContain("outside secret");
    expect(missingDirectory).toStartWith("Error:");
    expect(fileInsteadOfDirectory).toStartWith("Error:");
  });

  test("stops after the path cap and reports that more files remain", async () => {
    const cwd = await tempDir();
    for (let index = 0; index < 205; index++) {
      const name = `file-${String(index).padStart(3, "0")}.txt`;
      await writeFile(path.join(cwd, name), "");
    }
    const lateDirectory = path.join(cwd, "zzz-late");
    await mkdir(lateDirectory);
    await writeFile(path.join(lateDirectory, "should-not-be-read.txt"), "");

    // Make an incorrectly visited late subtree fail, without relying on timing.
    const canCheckEarlyStop =
      process.platform !== "win32" && process.getuid?.() !== 0;
    if (canCheckEarlyStop) await chmod(lateDirectory, 0);

    let result: string;
    try {
      result = await listFilesTool({}, cwd);
    } finally {
      if (canCheckEarlyStop) await chmod(lateDirectory, 0o700);
    }
    const pathsAndNote = result.split("\n");
    expect(pathsAndNote).toHaveLength(201);
    expect(pathsAndNote.at(-1)).toBe("[truncated; more paths remain]");
    expect(result).not.toContain("should-not-be-read.txt");
  });

  test("caps characters and reports the number omitted", async () => {
    const cwd = await tempDir();
    const names: string[] = [];
    for (let index = 0; index < 150; index++) {
      const name = `file-${String(index).padStart(3, "0")}-${"x".repeat(70)}.txt`;
      names.push(name);
      await writeFile(path.join(cwd, name), "");
    }

    const result = await listFilesTool({}, cwd);
    const fullList = names.sort().join("\n");
    const markerIndex = result.lastIndexOf("\n[truncated ");
    const keptText = result.slice(0, markerIndex);
    const omitted = Number(result.match(/\[truncated (\d+) chars\]$/)?.[1]);
    expect(result.length).toBeLessThanOrEqual(8_000);
    expect(omitted).toBe(fullList.length - keptText.length);
  });
});
