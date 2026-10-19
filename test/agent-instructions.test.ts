import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { runAgent } from "../src/loop";
import type { ChatClient } from "../src/llm";
import { runRepl } from "../src/cli";

const directories: string[] = [];

async function tempDir() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-instructions-"));
  directories.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

function completion(content: string): ChatCompletion {
  return {
    id: "test", created: 0, model: "test", object: "chat.completion", usage: undefined,
    choices: [{ finish_reason: "stop", index: 0, logprobs: null, message: { role: "assistant", content, refusal: null } }],
  };
}

function client(onRequest: (request: ChatCompletionCreateParamsNonStreaming) => void | Promise<void>): ChatClient {
  return { chat: { completions: { create: async (request) => {
    await onRequest(request);
    return completion("done");
  } } } };
}

test("missing AGENT.md leaves the base prompt unchanged without warning", async () => {
  const warnings: string[] = [];
  const result = await runAgent({ client: client(() => {}), model: "test", request: "hello", cwd: await tempDir(), reportWarning: (line) => warnings.push(line) });
  expect(result.messages[0]).toEqual({ role: "system", content: expect.not.stringContaining("Project instructions from AGENT.md:") });
  expect(warnings).toEqual([]);
});

test("includes present AGENT.md instructions in the system prompt", async () => {
  const cwd = await tempDir();
  await writeFile(path.join(cwd, "AGENT.md"), "follow local rules");
  const result = await runAgent({ client: client(() => {}), model: "test", request: "hello", cwd });
  expect(result.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("Project instructions from AGENT.md:\nfollow local rules") });
});

test("caps oversized instructions at 8,000 characters and warns once, but does not warn at exactly 8,000", async () => {
  const cwd = await tempDir();
  const warnings: string[] = [];
  await writeFile(path.join(cwd, "AGENT.md"), "x".repeat(8_001));
  const oversized = await runAgent({ client: client(() => {}), model: "test", request: "hello", cwd, reportWarning: (line) => warnings.push(line) });
  const oversizedPrompt = String(oversized.messages[0].content);
  expect(oversizedPrompt.split("Project instructions from AGENT.md:\n")[1]).toBe("x".repeat(8_000));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("8000");

  warnings.length = 0;
  await writeFile(path.join(cwd, "AGENT.md"), "y".repeat(8_000));
  const exact = await runAgent({ client: client(() => {}), model: "test", request: "hello", cwd, reportWarning: (line) => warnings.push(line) });
  expect(String(exact.messages[0].content).split("Project instructions from AGENT.md:\n")[1]).toBe("y".repeat(8_000));
  expect(warnings).toEqual([]);
});

test("/new reloads changed AGENT.md without retaining prior conversation instructions", async () => {
  const cwd = await tempDir();
  await writeFile(path.join(cwd, "AGENT.md"), "old instructions");
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const promptOutput = new PassThrough() as PassThrough & { isTTY: boolean };
  const answerOutput = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = promptOutput.isTTY = answerOutput.isTTY = true;
  Object.assign(input, { setRawMode: () => input });
  const messagesSeen: ChatCompletionCreateParamsNonStreaming["messages"][] = [];
  const mock = client(async (request) => {
    requests.push(request);
    messagesSeen.push([...request.messages]);
    if (requests.length === 1) await writeFile(path.join(cwd, "AGENT.md"), "new instructions");
  });
  const replies = ["first", "/new", "second", "/exit"];
  let promptOutputBuffer = "";
  promptOutput.on("data", (chunk: Buffer) => {
    promptOutputBuffer += chunk.toString();
    const promptCount = promptOutputBuffer.split("You: ").length - 1;
    while (replies.length > 0 && promptCount > 4 - replies.length) input.write(`${replies.shift()}\n`);
  });
  const repl = runRepl({ client: mock, model: "test" }, cwd, input as unknown as typeof process.stdin, promptOutput as unknown as typeof process.stderr, answerOutput as unknown as typeof process.stdout);
  await repl;
  expect(messagesSeen).toHaveLength(2);
  expect(String(messagesSeen[0][0].content)).toContain("old instructions");
  expect(String(messagesSeen[1][0].content)).toContain("new instructions");
  expect(String(messagesSeen[1][0].content)).not.toContain("old instructions");
  expect(messagesSeen[1]).toHaveLength(2);
});
