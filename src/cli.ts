import { createChatClient } from "./llm";
import { runAgent } from "./loop";

async function main() {
  const argument = process.argv.slice(2).join(" ").trim();
  const request = argument || (await Bun.stdin.text()).trim();
  if (!request) throw new Error("Provide a request as an argument or on stdin");

  const { client, model } = createChatClient();
  console.log(`You: ${request}`);
  const { answer } = await runAgent(client, model, request);
  console.log(`Assistant: ${answer}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
