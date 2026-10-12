import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { runAgent } from "../src/loop";
import { createChatClient, type ChatClient } from "../src/llm";
import { listFilesTool } from "../src/tools/list";
import { readFileTool } from "../src/tools/read";

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
