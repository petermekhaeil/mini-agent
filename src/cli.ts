import { createInterface } from "node:readline/promises";
import path from "node:path";
import { createChatClient } from "./llm";
import { runAgent } from "./loop";

export async function confirmBash(
  command: string,
  cwd: string,
  input: typeof process.stdin = process.stdin,
  output: typeof process.stderr = process.stderr,
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    output.write("Command approval denied: interactive stdin and stderr are required.\n");
    return false;
  }
  const prompt = createInterface({ input, output });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      input.off("close", onInputClosed);
      input.off("end", onInputClosed);
      prompt.close();
      resolve(approved);
    };
    const onInputClosed = () => finish(false);
    input.once("close", onInputClosed);
    input.once("end", onInputClosed);
    prompt.once("close", () => finish(false));
    prompt.once("SIGINT", () => finish(false));
    prompt.question(
      `Run command ${JSON.stringify(command)} in ${JSON.stringify(path.resolve(cwd))}? [y/N] `,
    ).then((answer) => finish(answer === "y" || answer === "Y"), () => finish(false));
  });
}

async function main() {
  const argument = process.argv.slice(2).join(" ").trim();
  const request = argument || (await Bun.stdin.text()).trim();
  if (!request) throw new Error("Provide a request as an argument or on stdin");

  const { client, model } = createChatClient();
  console.log(`You: ${request}`);
  const { answer } = await runAgent(client, model, request, process.cwd(), 25, confirmBash);
  console.log(`Assistant: ${answer}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
