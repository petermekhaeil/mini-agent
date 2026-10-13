import { createInterface } from "node:readline/promises";
import path from "node:path";
import { createChatClient } from "./llm";
import type { ChatClient } from "./llm";
import { runAgent } from "./loop";
import type { ConfirmEdit } from "./tools/edit";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type Ask = (prompt: string) => Promise<string | undefined>;

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
): ReturnType<ConfirmEdit> {
  const message = `Replace in ${JSON.stringify(target)}: old_str=${JSON.stringify(oldStr)}, new_str=${JSON.stringify(newStr)}? [y/N] `;
  return ask(message).then((answer) => answer === "y" || answer === "Y");
}

export async function runRepl(
  client: ChatClient,
  model: string,
  cwd: string,
  input: typeof process.stdin = process.stdin,
  promptOutput: typeof process.stderr = process.stderr,
  answerOutput: typeof process.stdout = process.stdout,
): Promise<void> {
  const terminal = createTerminalInput(input, promptOutput);
  let history: ChatCompletionMessageParam[] | undefined;
  try {
    while (true) {
      const request = await terminal.ask("You: ");
      if (request === undefined) return;
      const trimmed = request.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit") return;
      if (trimmed === "/new") {
        history = undefined;
        answerOutput.write("Conversation reset.\n");
        continue;
      }

      const result = await runAgent(
        client,
        model,
        trimmed,
        cwd,
        25,
        (command, workdir) => confirmBash(command, workdir, terminal.ask),
        (target, oldStr, newStr) => confirmEdit(target, oldStr, newStr, terminal.ask),
        history,
      );
      history = result.messages;
      answerOutput.write(`Assistant: ${result.answer}\n`);
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const argument = process.argv.slice(2).join(" ").trim();

  if (!argument && process.stdin.isTTY) {
    const { client, model } = createChatClient();
    await runRepl(client, model, process.cwd());
    return;
  }

  const request = argument || (await Bun.stdin.text()).trim();
  if (!request) throw new Error("Provide a request as an argument or on stdin");
  const { client, model } = createChatClient();
  console.log(`You: ${request}`);
  const terminal = process.stdin.isTTY
    ? createTerminalInput(process.stdin, process.stderr)
    : undefined;
  try {
    const { answer } = await runAgent(
      client,
      model,
      request,
      process.cwd(),
      25,
      terminal ? (command, cwd) => confirmBash(command, cwd, terminal.ask) : undefined,
      terminal ? (target, oldStr, newStr) => confirmEdit(target, oldStr, newStr, terminal.ask) : undefined,
    );
    console.log(`Assistant: ${answer}`);
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
