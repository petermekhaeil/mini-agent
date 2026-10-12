import { createChatClient } from "./llm";
import { runAgent } from "./loop";

async function main() {
  const argument = process.argv.slice(2).join(" ").trim();
  const request = argument || (await Bun.stdin.text()).trim();
  if (!request) throw new Error("Provide a request as an argument or on stdin");

  const { client, model } = createChatClient();
  const result = await runAgent(client, model, request);

  for (const message of result.messages) {
    if (message.role === "user") console.log(`You: ${message.content}`);

    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        if (call.type === "function") {
          console.log(
            `Assistant tool call: ${call.function.name}(${call.function.arguments})`,
          );
        } else {
          console.log(`Assistant custom tool call: ${call.custom.name}`);
        }
      }
    } else if (message.role === "tool") {
      console.log(`Tool result (${message.tool_call_id}):\n${message.content}`);
    } else if (message.role === "assistant") {
      console.log(`Assistant: ${message.content ?? ""}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
