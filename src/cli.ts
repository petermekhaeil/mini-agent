import { createInterface } from "node:readline/promises";
import path from "node:path";
import { createChatClient } from "./llm";
import type { Provider } from "./llm";
import { runAgent } from "./loop";
import type { RunAgentOptions } from "./loop";
import type { ConfirmEdit } from "./tools/edit";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { TokenMeter, formatSessionTotals, formatTokenReport } from "./tokens";

export type Ask = (prompt: string) => Promise<string | undefined>;

export function formatProviderModel(provider: Provider, model: string): string {
  return `Provider: ${provider} · Model: ${model}\n`;
}

export function createTerminalInput(
  input: typeof process.stdin = process.stdin,
  output: typeof process.stderr = process.stderr,
): { ask: Ask; close: () => void } {
  const reader = createInterface({ input, output });
  let closed = false;
  let ended = false;
  let readerClosed = false;
  const markEnded = () => { ended = true; };
  reader.once("close", () => { readerClosed = true; });
  input.once("end", markEnded);
  input.once("close", markEnded);

  const close = () => {
    if (closed) return;
    closed = true;
    input.off("end", markEnded);
    input.off("close", markEnded);
    reader.close();
  };

  const ask: Ask = async (prompt) => {
    if (closed || ended || readerClosed) return undefined;
    if (!input.isTTY || !output.isTTY) {
      output.write("Action approval denied: interactive stdin and stderr are required.\n");
      return undefined;
    }
    return new Promise((resolve) => {
      let settled = false;
      const abortQuestion = new AbortController();
      const finish = (answer: string | undefined) => {
        if (settled) return;
        settled = true;
        input.off("end", onInputEnd);
        input.off("close", onInputEnd);
        reader.off("close", onReaderClose);
        reader.off("SIGINT", onSigint);
        abortQuestion.abort();
        resolve(answer);
      };
      const onInputEnd = () => finish(undefined);
      const onReaderClose = () => finish(undefined);
      const onSigint = () => finish(undefined);
      input.once("end", onInputEnd);
      input.once("close", onInputEnd);
      reader.once("close", onReaderClose);
      reader.once("SIGINT", onSigint);
      reader.question(prompt, { signal: abortQuestion.signal })
        .then((answer) => finish(answer), () => finish(undefined));
    });
  };
  return { ask, close };
}

export function confirmBash(
  command: string,
  cwd: string,
  ask: Ask,
): Promise<boolean> {
  return ask(
    `Run command ${JSON.stringify(command)} in ${JSON.stringify(path.resolve(cwd))}? [y/N] `,
  ).then((answer) => answer === "y" || answer === "Y");
}

export function confirmEdit(
  target: string,
  oldStr: string,
  newStr: string,
  ask: Ask,
  color = false,
): ReturnType<ConfirmEdit> {
  const safe = (text: string) => text.replace(/[\\\u0000-\u0009\u000b-\u001f\u007f-\u009f\u001b\u202a-\u202e\u2066-\u2069]/g, (char) =>
    char === "\\" ? "\\\\" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const lines = (text: string, prefix: string, ansi: string) => {
    const safeText = safe(text);
    const content = safeText.endsWith("\n") ? safeText.slice(0, -1) : safeText;
    const rows = content ? content.split("\n") : ["(empty content)"];
    return rows.map((line) => `${color ? ansi : ""}${prefix}${color ? "\u001b[0m" : ""}${line}`).join("\n");
  };
  const safeTarget = safe(target).replace(/\n/g, "\\u000a");
  const after = newStr === "" ? "(empty replacement)" : lines(newStr, "+ ", "\u001b[32m");
  const newlineChange = oldStr.endsWith("\n") !== newStr.endsWith("\n")
    ? `\n[final newline ${newStr.endsWith("\n") ? "added" : "removed"}]` : "";
  const message = `Edit ${safeTarget}\nBefore:\n${lines(oldStr, "- ", "\u001b[31m")}\nAfter:\n${after}${newlineChange}\n[y/N] `;
  return ask(message).then((answer) => answer === "y" || answer === "Y");
}

export async function runRepl(
  config: Pick<RunAgentOptions, "client" | "model" | "reasoningEffort">,
  cwd: string,
  input: typeof process.stdin = process.stdin,
  promptOutput: typeof process.stderr = process.stderr,
  answerOutput: typeof process.stdout = process.stdout,
): Promise<void> {
  const { client, model, reasoningEffort } = config;
  const terminal = createTerminalInput(input, promptOutput);
  let history: ChatCompletionMessageParam[] | undefined;
  const meter = new TokenMeter();
  try {
    while (true) {
      const request = await terminal.ask("You: ");
      if (request === undefined) return;
      const trimmed = request.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit") return;
      if (trimmed === "/tokens") {
        promptOutput.write(formatTokenReport(meter));
        continue;
      }
      if (trimmed === "/new") {
        history = undefined;
        meter.reset();
        promptOutput.write("Conversation reset.\n");
        continue;
      }

      const result = await runAgent({
        client,
        model,
        reasoningEffort,
        request: trimmed,
        cwd,
        confirmBash: (command, workdir) => confirmBash(command, workdir, terminal.ask),
        confirmEdit: (target, oldStr, newStr) => confirmEdit(target, oldStr, newStr, terminal.ask, promptOutput.isTTY),
        history,
        meter,
        reportTokens: (line) => promptOutput.write(`${promptOutput.isTTY ? `\u001b[2m${line}\u001b[0m` : line}\n`),
      });
      history = result.messages;
      answerOutput.write(`Assistant: ${result.answer}\n`);
      promptOutput.write(formatSessionTotals(meter));
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const argument = process.argv.slice(2).join(" ").trim();

  if (!argument && process.stdin.isTTY) {
    const config = createChatClient();
    process.stderr.write(formatProviderModel(config.provider, config.model));
    await runRepl(config, process.cwd());
    return;
  }

  const request = argument || (await Bun.stdin.text()).trim();
  if (!request) throw new Error("Provide a request as an argument or on stdin");
  const config = createChatClient();
  process.stderr.write(formatProviderModel(config.provider, config.model));
  console.log(`You: ${request}`);
  const terminal = process.stdin.isTTY
    ? createTerminalInput(process.stdin, process.stderr)
    : undefined;
  try {
    const meter = new TokenMeter();
    const { answer } = await runAgent({
      ...config,
      request,
      cwd: process.cwd(),
      confirmBash: terminal ? (command, cwd) => confirmBash(command, cwd, terminal.ask) : undefined,
      confirmEdit: terminal ? (target, oldStr, newStr) => confirmEdit(target, oldStr, newStr, terminal.ask, process.stderr.isTTY) : undefined,
      meter,
      reportTokens: (line) => process.stderr.write(`${process.stderr.isTTY ? `\u001b[2m${line}\u001b[0m` : line}\n`),
    });
    console.log(`Assistant: ${answer}`);
    process.stderr.write(formatSessionTotals(meter));
  } finally {
    terminal?.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
