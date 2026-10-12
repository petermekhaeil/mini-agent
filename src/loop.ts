import type { ChatClient } from "./llm";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { readConfinedFile, readFileTool } from "./tools/read";

export const READ_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "read_file",
    description:
      "Read raw text from a file in the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the working directory",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export type Message = ChatCompletionMessageParam | ChatCompletionMessage;

const SYSTEM_PROMPT = [
  "You are a read-only coding assistant.",
  "Inspect the codebase to answer the user's request.",
  "Do not modify files or execute commands.",
  "Use read_file when you need to inspect files.",
].join(" ");

async function buildSystemPrompt(cwd: string): Promise<string> {
  try {
    const projectInstructions = await readConfinedFile("AGENT.md", cwd);
    return [
      SYSTEM_PROMPT,
      "",
      "Project instructions from AGENT.md:",
      projectInstructions,
    ].join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return SYSTEM_PROMPT;
  }
}

/** Run a bounded tool loop; the injected client keeps the API exchange testable. */
export async function runAgent(
  client: ChatClient,
  model: string,
  request: string,
  cwd = process.cwd(),
  maxTurns = 25,
): Promise<{ answer: string; messages: Message[] }> {
  const systemPrompt = await buildSystemPrompt(cwd);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: request },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: [READ_FILE_TOOL],
      tool_choice: "auto",
    });
    const assistant = response.choices[0]?.message;
    if (!assistant) {
      throw new Error("Model returned no assistant message");
    }

    // The API requires the full assistant turn before its tool results.
    messages.push(assistant);
    if (!assistant.tool_calls?.length) {
      return {
        answer: assistant.content ?? "",
        messages,
      };
    }

    for (const call of assistant.tool_calls) {
      let result: string;

      if (call.type !== "function") {
        result = "Error: unsupported custom tool call";
      } else if (call.function.name !== "read_file") {
        result = `Error: unknown tool ${call.function.name}`;
      } else {
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          result = await readFileTool(args, cwd);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = `Error: ${message}`;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  throw new Error(
    `Agent stopped after ${maxTurns} turns without a final answer`,
  );
}
