import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { runAgent } from "../src/loop";
import { createChatClient, type ChatClient } from "../src/llm";
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
    expect(result.messages[3]).toMatchObject({ role: "tool", tool_call_id: "bad" });
    expect(result.messages[4]).toMatchObject({ role: "tool", tool_call_id: "missing" });
    expect(result.messages[5]).toMatchObject({ role: "tool", tool_call_id: "no-path" });
    expect(result.messages[6]).toMatchObject({ role: "tool", tool_call_id: "null" });
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
