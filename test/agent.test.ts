import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
import { editFileTool } from "../src/tools/edit";
import { codeSearchTool } from "../src/tools/search";
import { confirmBash, confirmEdit, createTerminalInput, formatProviderModel, runRepl } from "../src/cli";
import type { Ask } from "../src/cli";
import { TokenMeter, formatTokenReport } from "../src/tokens";

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
  usage?: ChatCompletion["usage"],
): ChatCompletion {
  return {
    id: "test-completion",
    created: 0,
    model: "test-model",
    object: "chat.completion",
    usage,
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

describe("token meter", () => {
  test("records each model call and propagates unknown usage without treating zero as missing", async () => {
    const meter = new TokenMeter();
    const lines: string[] = [];
    await runAgent({ client: mockClient([
      mockCompletion({ role: "assistant", content: null, refusal: null, tool_calls: [{
        id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"absent"}' },
      }] }, { prompt_tokens: 4210, completion_tokens: 0, total_tokens: 4210, prompt_tokens_details: { cached_tokens: 3900 } }),
      mockCompletion({ role: "assistant", content: "done", refusal: null }, { prompt_tokens: 0, completion_tokens: 182, total_tokens: 182, prompt_tokens_details: {} }),
    ]), model: "test-model", request: "read absent", cwd: await tempDir(), meter, reportTokens: (line) => lines.push(line) });
    expect(meter.turns).toEqual([
      { turn: 1, prompt: 4210, cached: 3900, completion: 0 },
      { turn: 2, prompt: 0, cached: null, completion: 182 },
    ]);
    expect(meter.totals).toEqual({ prompt: 4210, cached: null, completion: 182, total: 4392 });
    expect(lines[0]).toContain("[turn 1] ctx 4,210 (cached 3,900) · out 0");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("[turn "))).toBe(true);
    const report = formatTokenReport(meter);
    expect(report).toContain("left column = turn");
    expect(report).toContain("1");
    expect(report).toContain("4,210");
    expect(report).toContain("3,900");
    expect(report).toContain("n/a");
    expect(report).toContain("182");
  });

  test("records missing usage as unknown and reset clears calls", async () => {
    const meter = new TokenMeter();
    const messages: string[] = [];
    const noMessage = mockCompletion({ role: "assistant", content: null, refusal: null });
    noMessage.choices = [];
    await expect(runAgent({ client: mockClient([noMessage]), model: "test-model", request: "request", cwd: await tempDir(), maxTurns: 1, meter, reportTokens: (line) => messages.push(line) })).rejects.toThrow("no assistant message");
    expect(meter.totals).toEqual({ prompt: null, cached: null, completion: null, total: null });
    expect(messages[0]).toContain("[turn 1]");
    meter.reset();
    expect(meter.turns).toHaveLength(0);
    expect(formatTokenReport(meter)).toContain("No model calls yet.");
    expect(formatTokenReport(meter)).toContain("Session totals: input 0 (cached 0) · out 0 · total 0");
  });
});

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
  test.each([
    ["gpt-6-luna", "none"],
    ["test-model", undefined],
  ] as const)("forwards configured reasoning effort for %s", async (model, reasoningEffort) => {
    const requests: ChatCompletionCreateParamsNonStreaming[] = [];
    await runAgent({
      client: mockClient([mockCompletion({ role: "assistant", content: "done", refusal: null })], (request) => requests.push(request)),
      model,
      reasoningEffort,
      request: "hello",
      cwd: await tempDir(),
    });

    if (reasoningEffort) expect(requests[0].reasoning_effort).toBe(reasoningEffort);
    else expect("reasoning_effort" in requests[0]).toBe(false);
  });

  test("reuses a copied history with one system message and complete tool turns", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "note.txt"), "remembered result");
    const first = await runAgent({ client: mockClient([
      mockCompletion({
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [{
          id: "history-read",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"note.txt"}' },
        }],
      }),
      mockCompletion({ role: "assistant", content: "First answer", refusal: null }),
    ]), model: "test-model", request: "first request", cwd });
    const history = first.messages;
    const originalHistory = structuredClone(history);
    let secondRequest: ChatCompletionCreateParamsNonStreaming | undefined;
    await runAgent({ client: mockClient([
      mockCompletion({ role: "assistant", content: "Second answer", refusal: null }),
    ], (request) => { secondRequest = structuredClone(request); }), model: "test-model", request: "second request", cwd, history });

    expect(history).toEqual(originalHistory);
    expect(secondRequest?.messages).toHaveLength(history.length + 1);
    expect(secondRequest?.messages.slice(0, history.length)).toEqual(history);
    expect(secondRequest?.messages.at(-1)).toEqual({ role: "user", content: "second request" });
    expect(secondRequest?.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(secondRequest?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "history-read", content: "remembered result" }));
    expect(secondRequest?.messages).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }));
  });

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

    const result = await runAgent({ client, model: "test-model", request: "Read note.txt", cwd });
    expect(result.answer).toBe("It says hello and world.");
    expect(calls[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Prefer concise explanations."),
    });
    expect(calls[0].messages[1]).toEqual({
      role: "user",
      content: "Read note.txt",
    });
    const systemPrompt = String(result.messages[0].content);
    expect(systemPrompt).toContain("Use code_search, list_files, and read_file for read-only discovery.");
    expect(systemPrompt).toContain("call bash or edit_file directly instead of asking approval in chat");
    expect(systemPrompt).toContain("Never retry a denied action.");
    const toolDescriptions = calls[0].tools
      ?.filter((tool) => tool.type === "function")
      .map((tool) => tool.function.description)
      .join(" ");
    expect(toolDescriptions).toContain("requests terminal approval before running");
    expect(toolDescriptions).toContain("requests terminal approval before editing");
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
    const result = await runAgent({ client, model: "test-model", request: "Read files", cwd });
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
    const result = await runAgent({ client, model: "test-model", request: "run commands", cwd, confirmBash: async (command, dir) => {
      confirmations.push([command, dir]);
      return true;
    } });
    expect(confirmations).toEqual([["printf 1", cwd], ["printf 2", cwd]]);
    expect(calls[1].messages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "bash-one" });
    expect(calls[1].messages.at(-2)?.content).toContain("stdout:\n1");
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "bash-two" });
    expect(calls[1].messages.at(-1)?.content).toContain("stdout:\n2");
    expect(result.answer).toBe("done");
  });

  test("executes edit_file calls with individual confirmations and matching IDs", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "a.txt"), "A");
    await writeFile(path.join(cwd, "b.txt"), "B");
    const calls: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = mockClient([
      mockCompletion({
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: ["a", "b"].map((name) => ({
          id: `edit-${name}`,
          type: "function" as const,
          function: {
            name: "edit_file",
            arguments: JSON.stringify({ path: `${name}.txt`, old_str: name.toUpperCase(), new_str: `${name}!` }),
          },
        })),
      }),
      mockCompletion({ role: "assistant", content: "done", refusal: null }),
    ], (request) => calls.push(structuredClone(request)));
    const approvals: string[] = [];
    await runAgent({ client, model: "test-model", request: "edit both", cwd, confirmEdit: async (target) => {
      approvals.push(target);
      return true;
    } });
    const canonicalCwd = await realpath(cwd);
    expect(approvals).toEqual([path.join(canonicalCwd, "a.txt"), path.join(canonicalCwd, "b.txt")]);
    expect(calls[1].messages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "edit-a" });
    expect(calls[1].messages.at(-2)?.content).toContain("Updated");
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "edit-b" });
    expect(calls[1].messages.at(-1)?.content).toContain("Updated");
    expect(await Bun.file(path.join(cwd, "a.txt")).text()).toBe("a!");
    expect(await Bun.file(path.join(cwd, "b.txt")).text()).toBe("b!");
  });

  test("executes code_search calls with matching IDs and registers the tool", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "src.ts"), "const needle = true;\n");
    const calls: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = mockClient([
      mockCompletion({
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [{
          id: "search-call",
          type: "function",
          function: { name: "code_search", arguments: JSON.stringify({ pattern: "needle" }) },
        }],
      }),
      mockCompletion({ role: "assistant", content: "Found it.", refusal: null }),
    ], (request) => calls.push(structuredClone(request)));

    const result = await runAgent({ client, model: "test-model", request: "Find needle", cwd });
    expect(result.answer).toBe("Found it.");
    expect(calls[0].tools?.map((tool) => tool.type === "function" ? tool.function.name : "")).toContain("code_search");
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "search-call" });
    expect(calls[1].messages.at(-1)?.content).toContain("src.ts:1:const needle = true;");
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

describe("code_search", () => {
  test("searches the project root or a scoped path and filters with glob", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "src"));
    await mkdir(path.join(cwd, "docs"));
    await writeFile(path.join(cwd, "src", "app.ts"), "const needle = 1;\n");
    await writeFile(path.join(cwd, "src", "other.js"), "const needle = 2;\n");
    await writeFile(path.join(cwd, "docs", "readme.md"), "needle in docs\n");

    const rootResults = await codeSearchTool({ pattern: "needle" }, cwd);
    expect(rootResults).toContain("src/app.ts:1:const needle = 1;");
    expect(rootResults).toContain("docs/readme.md:1:needle in docs");

    const scoped = await codeSearchTool({ pattern: "needle", path: "src", glob: "*.ts" }, cwd);
    expect(scoped).toBe("src/app.ts:1:const needle = 1;");
    expect(scoped).not.toContain("other.js");
  });

  test("reports invalid regexes, no matches, leading-dash patterns, and bad arguments", async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, "sample.txt"), "-needle here\nordinary\n");
    expect(await codeSearchTool({ pattern: "[" }, cwd)).toMatch(/^Error: ripgrep failed/);
    expect(await codeSearchTool({ pattern: "absent" }, cwd)).toBe("(no matches)");
    expect(await codeSearchTool({ pattern: "-needle" }, cwd)).toContain("sample.txt:1:-needle here");
    expect(await codeSearchTool({ pattern: "" }, cwd)).toContain("pattern must be a non-empty string");
    expect(await codeSearchTool({ pattern: "needle", path: 4 }, cwd)).toContain("path must be a non-empty string");
    expect(await codeSearchTool({ pattern: "needle", glob: "" }, cwd)).toContain("glob must be a non-empty string");
    expect(await codeSearchTool(null, cwd)).toContain("arguments must be an object");
  });

  test("confines paths and limits results by both line count and characters", async () => {
    const parent = await tempDir();
    const cwd = path.join(parent, "work");
    const outside = path.join(parent, "outside.txt");
    await mkdir(cwd);
    await writeFile(outside, "needle outside\n");
    await symlink(outside, path.join(cwd, "linked.txt"));
    expect(await codeSearchTool({ pattern: "needle", path: "../outside.txt" }, cwd)).toStartWith("Error:");
    expect(await codeSearchTool({ pattern: "needle", path: "linked.txt" }, cwd)).toStartWith("Error:");
    expect(await codeSearchTool({ pattern: "needle", path: "missing.txt" }, cwd)).toStartWith("Error:");

    const manyShortLines = Array.from({ length: 130 }, (_, index) => `needle ${index}`).join("\n");
    await writeFile(path.join(cwd, "many.txt"), manyShortLines);
    const lineLimited = await codeSearchTool({ pattern: "needle", path: "many.txt" }, cwd);
    expect(lineLimited).toContain("additional matches omitted");
    expect(lineLimited.split("\n").filter((line) => /many\.txt:\d+:/.test(line))).toHaveLength(100);
    expect(lineLimited.split("\n")).toHaveLength(101);

    const longLines = Array.from({ length: 80 }, (_, index) => `needle ${index} ${"x".repeat(200)}`).join("\n");
    await writeFile(path.join(cwd, "long.txt"), longLines);
    const charLimited = await codeSearchTool({ pattern: "needle", path: "long.txt" }, cwd);
    expect(charLimited.length).toBeLessThanOrEqual(8_000);
    expect(charLimited).toContain("8,000 character limit");
  });
});

describe("edit_file", () => {
  test("replaces one exact occurrence and keeps replacement tokens literal", async () => {
    const cwd = await tempDir();
    const target = path.join(await realpath(cwd), "note.txt");
    await writeFile(target, "before OLD after");
    const result = await editFileTool(
      { path: "note.txt", old_str: "OLD", new_str: "$& and $$" },
      cwd,
      async (approvedTarget, oldStr, newStr) => {
        expect(approvedTarget).toBe(target);
        expect(oldStr).toBe("OLD");
        expect(newStr).toBe("$& and $$");
        return true;
      },
    );
    expect(result).toContain("Updated");
    expect(await Bun.file(target).text()).toBe("before $& and $$ after");
  });

  test("missing, duplicate, overlapping, or empty old text do not prompt or modify", async () => {
    const cwd = await tempDir();
    const target = path.join(cwd, "note.txt");
    await writeFile(target, "aaa and OLD OLD");
    let prompts = 0;
    for (const [old_str, expected] of [["missing", "not found"], ["OLD", "exactly once"], ["aa", "exactly once"], ["", "non-empty"]]) {
      const result = await editFileTool({ path: "note.txt", old_str, new_str: "changed" }, cwd, async () => { prompts++; return true; });
      expect(result).toContain(expected);
      expect(await Bun.file(target).text()).toBe("aaa and OLD OLD");
    }
    expect(prompts).toBe(0);
  });

  test("default denial has no side effects; malformed args do not prompt", async () => {
    const cwd = await tempDir();
    const target = path.join(cwd, "existing.txt");
    await writeFile(target, "old");
    expect(await editFileTool({ path: "existing.txt", old_str: "old", new_str: "new" }, cwd)).toContain("denied");
    expect(await editFileTool({ path: "existing.txt", old_str: "old", new_str: "new" }, cwd, async () => false)).toContain("denied");
    expect(await Bun.file(target).text()).toBe("old");
    let prompts = 0;
    for (const args of [null, "bad", {}, { path: "x", old_str: 0, new_str: "" }, { path: "x", old_str: "", new_str: 0 }, { path: "x", old_str: "old", new_str: "\ud800" }]) {
      expect(await editFileTool(args, cwd, async () => { prompts++; return true; })).toStartWith("Error:");
    }
    expect(await editFileTool({ path: "missing.txt", old_str: "old", new_str: "new" }, cwd, async () => { prompts++; return true; })).toStartWith("Error:");
    expect(prompts).toBe(0);
  });

  test("rejects missing targets before approval", async () => {
    const cwd = await tempDir();
    let prompts = 0;
    const result = await editFileTool({ path: "missing.txt", old_str: "old", new_str: "new" }, cwd, async () => { prompts++; return true; });
    expect(result).toStartWith("Error:");
    expect(prompts).toBe(0);
    expect(await Bun.file(path.join(cwd, "missing.txt")).exists()).toBe(false);
  });

  test("rejects traversal, outside symlink targets and symlinked parents", async () => {
    const parent = await tempDir();
    const cwd = path.join(parent, "work");
    const outside = path.join(parent, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(cwd, "linked.txt"));
    await symlink(outside, path.join(cwd, "linked-dir"));
    const brokenLink = path.join(cwd, "broken.txt");
    await symlink(path.join(outside, "missing.txt"), brokenLink);
    const confirm = async () => true;
    expect(await editFileTool({ path: "../outside/secret.txt", old_str: "secret", new_str: "x" }, cwd, confirm)).toStartWith("Error:");
    expect(await editFileTool({ path: "linked.txt", old_str: "secret", new_str: "x" }, cwd, confirm)).toStartWith("Error:");
    expect(await editFileTool({ path: "linked-dir/new.txt", old_str: "x", new_str: "y" }, cwd, confirm)).toStartWith("Error:");
    expect(await editFileTool({ path: "broken.txt", old_str: "x", new_str: "y" }, cwd, confirm)).toStartWith("Error:");
    expect((await lstat(brokenLink)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(outsideFile).text()).toBe("secret");
  });

  test("rejects invalid UTF-8 before approval", async () => {
    const cwd = await tempDir();
    const target = path.join(cwd, "invalid.txt");
    const invalid = Buffer.concat([Buffer.from([0xff]), Buffer.from("OLD")]);
    await writeFile(target, invalid);
    let prompts = 0;
    const initial = await editFileTool({ path: "invalid.txt", old_str: "OLD", new_str: "NEW" }, cwd, async () => { prompts++; return true; });
    expect(initial).toContain("valid UTF-8");
    expect(prompts).toBe(0);
    expect(await Bun.file(target).bytes()).toEqual(invalid);
  });

  test("preserves a valid UTF-8 BOM and permits empty replacement", async () => {
    const cwd = await tempDir();
    const bomFile = path.join(cwd, "bom.txt");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(bomFile, Buffer.concat([bom, Buffer.from("OLD")]));
    const replaced = await editFileTool({ path: "bom.txt", old_str: "OLD", new_str: "NEW" }, cwd, async () => true);
    expect(replaced).toContain("Updated");
    expect(await Bun.file(bomFile).bytes()).toEqual(Buffer.concat([bom, Buffer.from("NEW")]));

    const emptied = await editFileTool({ path: "bom.txt", old_str: "NEW", new_str: "" }, cwd, async () => true);
    expect(emptied).toContain("Updated");
    expect(await Bun.file(bomFile).bytes()).toEqual(bom);
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
    const terminal = createTerminalInput(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
    const pending = confirmBash("touch sentinel", "/work", terminal.ask);
    input.destroy();
    expect(await pending).toBe(false);
    terminal.close();
    output.destroy();
  });

  test("accepts only y or Y", async () => {
    for (const [reply, expected] of [["y\n", true], ["Y\n", true], ["yes\n", false], ["\n", false]] as const) {
      const { input, output } = ttyPair();
      const terminal = createTerminalInput(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
      const pending = confirmBash("pwd", "/work", terminal.ask);
      input.write(reply);
      expect(await pending).toBe(expected);
      terminal.close();
      input.destroy();
      output.destroy();
    }
  });

  test("denies non-interactive input without waiting for a reply", async () => {
    const input = new PassThrough();
    const { output } = ttyPair();
    const terminal = createTerminalInput(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
    input.write("y\n");
    expect(await confirmBash("pwd", "/work", terminal.ask)).toBe(false);
    terminal.close();
    input.destroy();
    output.destroy();
  });

  test("settles false on input EOF", async () => {
    const { input, output } = ttyPair();
    const terminal = createTerminalInput(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
    const pending = confirmBash("pwd", "/work", terminal.ask);
    input.end();
    expect(await pending).toBe(false);
    terminal.close();
    output.destroy();
  });

  test("settles false on Ctrl-C", async () => {
    const { input, output } = ttyPair();
    const terminal = createTerminalInput(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
    const pending = confirmBash("touch sentinel", "/work", terminal.ask);
    input.emit("keypress", "\u0003", { ctrl: true, name: "c" });
    expect(await pending).toBe(false);
    terminal.close();
    input.destroy();
    output.destroy();
  });

  test("edit prompt shows safe full replacement and requires y/Y", async () => {
    const { input, output } = ttyPair();
    let shown = "";
    output.on("data", (chunk) => { shown += chunk.toString(); });
    const oldStr = 'old\n"text"';
    const newStr = 'new $& and $$';
    const terminal = createTerminalInput(input as unknown as typeof process.stdin, output as unknown as typeof process.stderr);
    const pending = confirmEdit("/work/a.txt", oldStr, newStr, terminal.ask, true);
    input.write("Y\n");
    expect(await pending).toBe(true);
    expect(shown).toContain("Edit /work/a.txt\nBefore:\n\u001b[31m- \u001b[0mold\n\u001b[31m- \u001b[0m\"text\"");
    expect(shown).toContain("After:\n\u001b[32m+ \u001b[0mnew $& and $$\n[y/N]");
    terminal.close();
    input.destroy();
    output.destroy();

    const nonTTY = new PassThrough();
    const ttyOutput = new PassThrough() as PassThrough & { isTTY: boolean };
    Object.defineProperty(ttyOutput, "isTTY", { value: true });
    let denialMessage = "";
    ttyOutput.on("data", (chunk) => { denialMessage += chunk.toString(); });
    const nonInteractive = createTerminalInput(nonTTY as unknown as typeof process.stdin, ttyOutput as unknown as typeof process.stderr);
    expect(await confirmEdit("/work/a.txt", "", "new", nonInteractive.ask)).toBe(false);
    expect(denialMessage).toContain("Action approval denied");
    nonInteractive.close();
    nonTTY.destroy();
    ttyOutput.destroy();

    const { input: noInput, output: noOutput } = ttyPair();
    const noInputTerminal = createTerminalInput(noInput as unknown as typeof process.stdin, noOutput as unknown as typeof process.stderr);
    const denied = confirmEdit("/work/a.txt", "old", "new", noInputTerminal.ask);
    noInput.write("n\n");
    expect(await denied).toBe(false);
    noInputTerminal.close();
    noInput.destroy();
    noOutput.destroy();
  });

  test("edit preview is plain, escapes controls, and does not truncate", async () => {
    let prompt = "";
    const ask: Ask = async (text) => { prompt = text; return "n"; };
    const long = "x".repeat(10_000);
    expect(await confirmEdit("bad\u001b[2J", "one\r\ntwo\n", `safe\u001b[31m\n${long}`, ask)).toBe(false);
    expect(prompt).toContain("Edit bad\\u001b[2J");
    expect(prompt).toContain("- one\\u000d\n- two");
    expect(prompt).toContain("+ safe\\u001b[31m");
    expect(prompt).toContain(long);
    expect(prompt).not.toContain("\u001b[31m");
    expect(prompt).toContain("[y/N]");
  });

  test("edit preview keeps filename newlines on one heading and marks empty replacement", async () => {
    let prompt = "";
    const ask: Ask = async (text) => { prompt = text; return "n"; };
    expect(await confirmEdit("file\nAfter: spoof", "remove me", "", ask)).toBe(false);
    expect(prompt).toContain("Edit file\\u000aAfter: spoof\nBefore:");
    expect(prompt).toContain("After:\n(empty replacement)\n[y/N]");
    const emptyReplacement = prompt;
    await confirmEdit("file", "remove me", "(empty)", ask);
    expect(prompt).toContain("After:\n+ (empty)\n[y/N]");
    expect(prompt).not.toBe(emptyReplacement);
    await confirmEdit("file", "", "literal \\\\u001b", ask);
    expect(prompt).toContain("+ literal \\\\\\\\u001b");
  });
  test("marks final-newline changes even when replacement content also differs", async () => {
    let prompt = "";
    const ask: Ask = async (text) => { prompt = text; return "n"; };
    await confirmEdit("file", "old\n", "new", ask);
    expect(prompt).toContain("[final newline removed]");
    await confirmEdit("file", "old", "new", ask);
    expect(prompt).not.toContain("[final newline");
  });
});

describe("interactive REPL", () => {
  function ttyPair() {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    Object.defineProperty(input, "isTTY", { value: true });
    Object.defineProperty(output, "isTTY", { value: true });
    return { input, output };
  }

  test("keeps one reader for user turns and approvals, and /new resets history", async () => {
    const cwd = await tempDir();
    const createBashCall = (id: string, command: string) => mockCompletion({
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: [{ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
    });
    const requests: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = mockClient([
      createBashCall("approved", "echo approved"),
      mockCompletion({ role: "assistant", content: "First answer", refusal: null }),
      createBashCall("denied", "echo denied"),
      mockCompletion({ role: "assistant", content: "Second answer", refusal: null }),
      mockCompletion({ role: "assistant", content: "Fresh answer", refusal: null }),
    ], (request) => requests.push(structuredClone(request)));
    const { input, output } = ttyPair();
    const prompts: [string, string][] = [
      ["You: ", "first request\n"],
      [`Run command ${JSON.stringify("echo approved")} in ${JSON.stringify(path.resolve(cwd))}? [y/N] `, "y\n"],
      ["You: ", "second request\n"],
      [`Run command ${JSON.stringify("echo denied")} in ${JSON.stringify(path.resolve(cwd))}? [y/N] `, "n\n"],
      ["You: ", "/new\n"],
      ["You: ", "fresh request\n"],
      ["You: ", "/exit\n"],
    ];
    let transcript = "";
    let pendingOutput = "";
    output.on("data", (chunk) => {
      const text = chunk.toString();
      transcript += text;
      pendingOutput += text;
      while (prompts.length > 0) {
        const [prompt, reply] = prompts[0];
        const index = pendingOutput.indexOf(prompt);
        if (index < 0) break;
        pendingOutput = pendingOutput.slice(index + prompt.length);
        prompts.shift();
        queueMicrotask(() => input.write(reply));
      }
    });

    await runRepl({ client, model: "test-model" }, cwd, input as unknown as typeof process.stdin, output as unknown as typeof process.stderr, output as unknown as typeof process.stdout);

    expect(prompts).toHaveLength(0);
    expect(requests[2].messages.at(-1)).toEqual({ role: "user", content: "second request" });
    expect(requests[2].messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(requests[3].messages.at(-1)?.content).toContain("Command denied");
    expect(requests[4].messages).toHaveLength(2);
    expect(requests[4].messages.at(-1)).toEqual({ role: "user", content: "fresh request" });
    expect(transcript).toContain("Conversation reset.");
    expect(transcript).toContain("Assistant: Fresh answer");
    input.destroy();
    output.destroy();
  });

  test("exits cleanly when Ctrl-D closes input", async () => {
    const { input, output } = ttyPair();
    const client = mockClient([]);
    const pending = runRepl({ client, model: "test-model" }, "/unused", input as unknown as typeof process.stdin, output as unknown as typeof process.stderr, output as unknown as typeof process.stdout);
    input.emit("end");
    await pending;
    output.destroy();
  });

  test("/tokens reports calls without a model request; /new resets the meter and routes status to stderr", async () => {
    const cwd = await tempDir();
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const stderr = new PassThrough() as PassThrough & { isTTY: boolean };
    const stdout = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    Object.defineProperty(stderr, "isTTY", { value: true });
    const requests: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = mockClient([
      mockCompletion({ role: "assistant", content: "one", refusal: null }, { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 0 } }),
      mockCompletion({ role: "assistant", content: "two", refusal: null }, { prompt_tokens: 25, completion_tokens: 4, total_tokens: 29, prompt_tokens_details: { cached_tokens: 5 } }),
      mockCompletion({ role: "assistant", content: "fresh", refusal: null }, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } }),
    ], (request) => requests.push(request));
    let err = "";
    let out = "";
    stderr.on("data", (chunk) => { err += chunk.toString(); });
    stdout.on("data", (chunk) => { out += chunk.toString(); });
    const prompts: [string, string][] = [
      ["You: ", "first\n"], ["You: ", "/tokens\n"], ["You: ", "second\n"],
      ["You: ", "/new\n"], ["You: ", "fresh\n"], ["You: ", "/tokens\n"], ["You: ", "/exit\n"],
    ];
    let pending = "";
    stderr.on("data", (chunk) => {
      pending += chunk.toString();
      while (prompts.length && pending.includes(prompts[0][0])) {
        pending = pending.slice(pending.indexOf(prompts[0][0]) + prompts[0][0].length);
        const [, reply] = prompts.shift()!;
        queueMicrotask(() => input.write(reply));
      }
    });
    await runRepl({ client, model: "gpt-6-luna", reasoningEffort: "none" }, cwd, input as unknown as typeof process.stdin, stderr as unknown as typeof process.stderr, stdout as unknown as typeof process.stdout);
    expect(prompts).toHaveLength(0);
    expect(err).toContain("│ 1 │ 20");
    expect(err).toContain("[turn 2] ctx 25 (cached 5) · out 4 · total 52");
    expect(err).toContain("[turn 2] ctx 25 (cached 5) · out 4");
    expect(err).toContain("Conversation reset.");
    expect(err).toContain("Session totals: input 7 (cached 0) · out 2 · total 9");
    expect((err.match(/\[turn 1\]/g) ?? [])).toHaveLength(2);
    expect(requests[0].reasoning_effort).toBe("none");
    expect(err).not.toContain("initial prompt");
    expect(err).toContain("│ 1 │ 7");
    expect(out).toContain("Assistant: one");
    expect(out).toContain("Assistant: two");
    expect(out).toContain("Assistant: fresh");
    expect(out).not.toContain("Conversation reset");
    expect(out).not.toContain("Tokens per model call");
    expect(err).toContain("\u001b[2m");
    input.destroy(); stderr.destroy(); stdout.destroy();
  });
});

describe("provider configuration", () => {
  test("defaults to OpenAI and supports a model override", () => {
    const defaultConfig = createChatClient({ OPENAI_API_KEY: "test-key" });
    expect(defaultConfig.client.apiKey).toBe("test-key");
    expect(defaultConfig.client.baseURL).toBe("https://api.openai.com/v1");
    expect(defaultConfig.model).toBe("gpt-6-luna");
    expect(defaultConfig.provider).toBe("openai");
    expect(defaultConfig.reasoningEffort).toBe("none");
    const lunaOverride = createChatClient({ OPENAI_API_KEY: "test-key", AGENT_MODEL: " gpt-6-luna " });
    expect(lunaOverride.model).toBe("gpt-6-luna");
    expect(lunaOverride.reasoningEffort).toBe("none");
    expect(createChatClient({ OPENAI_API_KEY: "test-key", AGENT_MODEL: "test-model" }).reasoningEffort).toBeUndefined();
  });

  test.each([
    ["xai", "XAI_API_KEY", "grok-4.7", "https://api.x.ai/v1"],
  ] as const)("configures %s with its selected key, URL, and default model", (provider, keyName, model, baseURL) => {
    const config = createChatClient({ AGENT_PROVIDER: provider, [keyName]: "selected-key" });
    expect(config.provider).toBe(provider);
    expect(config.client.apiKey).toBe("selected-key");
    expect(config.client.baseURL).toBe(baseURL);
    expect(config.model).toBe(model);
    expect(config.reasoningEffort).toBeUndefined();
  });

  test("does not enable Luna reasoning for xAI with a Luna model override", () => {
    const config = createChatClient({ AGENT_PROVIDER: "xai", XAI_API_KEY: "selected-key", AGENT_MODEL: "gpt-6-luna" });
    expect(config.model).toBe("gpt-6-luna");
    expect(config.reasoningEffort).toBeUndefined();
  });

  test.each([
    ["openai", "OPENAI_API_KEY"],
    ["xai", "XAI_API_KEY"],
  ] as const)("requires the selected %s key without falling back", (provider, keyName) => {
    const otherKeys: Record<string, string | undefined> = { OPENAI_API_KEY: "openai-secret", XAI_API_KEY: "xai-secret" };
    delete otherKeys[keyName];
    expect(() => createChatClient({ AGENT_PROVIDER: provider, ...otherKeys })).toThrow(`${keyName} is required`);
    expect(() => createChatClient({ AGENT_PROVIDER: provider, [keyName]: "" })).toThrow(`${keyName} is required`);
  });

  test("rejects unsupported providers and an empty model override", () => {
    expect(() => createChatClient({ AGENT_PROVIDER: "other", OPENAI_API_KEY: "secret" })).toThrow("Unknown AGENT_PROVIDER");
    expect(() => createChatClient({ OPENAI_API_KEY: "secret", AGENT_MODEL: "   " })).toThrow("AGENT_MODEL must be a non-empty model name");
  });

  test("formats only the safe provider and model labels", () => {
    expect(formatProviderModel("xai", "grok-4.7")).toBe("Provider: xai · Model: grok-4.7\n");
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

  test("refuses hidden paths, including aliases and hidden components before normalization", async () => {
    const cwd = await tempDir();
    const secret = "hidden secret content";
    await writeFile(path.join(cwd, ".env"), secret);
    await mkdir(path.join(cwd, ".hidden"));
    await writeFile(path.join(cwd, ".hidden", "file"), secret);
    await mkdir(path.join(cwd, "dir"));
    await writeFile(path.join(cwd, "visible.txt"), "visible content");
    await symlink(path.join(cwd, ".env"), path.join(cwd, "env-alias"));
    await symlink(path.join(cwd, ".hidden"), path.join(cwd, "hidden-alias"));

    for (const hiddenPath of [
      ".env", ".hidden/file", "dir/.hidden/../visible.txt", "env-alias", "hidden-alias/file",
    ]) {
      const result = await readFileTool({ path: hiddenPath }, cwd);
      expect(result).toStartWith("Error:");
      expect(result).not.toContain(secret);
    }
    expect(await readFileTool({ path: "./visible.txt" }, cwd)).toBe("visible content");
  });

  test("allows visible files when the working directory itself is hidden", async () => {
    const parent = await tempDir();
    const cwd = path.join(parent, ".workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "visible.txt"), "visible content");
    expect(await readFileTool({ path: "visible.txt" }, cwd)).toBe("visible content");
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
