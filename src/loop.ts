import type { ChatClient } from "./llm";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { listFilesTool } from "./tools/list";
import { readConfinedFile, readFileTool } from "./tools/read";
import { bashTool, type ConfirmBash } from "./tools/bash";

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

export const LIST_FILES_TOOL = {
  type: "function" as const,
  function: {
    name: "list_files",
    description: "List repository file paths recursively under a directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the working directory; defaults to .",
        },
      },
      additionalProperties: false,
    },
  },
};

export const BASH_TOOL = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Request a shell command in the working directory. Call this tool directly; it asks the user for approval before running.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export type Message = ChatCompletionMessageParam | ChatCompletionMessage;

const SYSTEM_PROMPT = [
  "You are a coding assistant. Use bash when a shell command would help.",
  "Inspect the codebase to answer the user's request.",
  "The bash tool asks the user for approval. Call it directly instead of asking for approval in a chat reply.",
  "Do not modify files except through an approved command. If a command is denied, do not retry it.",
  "Use list_files to find files and read_file to inspect their contents.",
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
  confirmBash: ConfirmBash = async () => false,
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
      tools: [READ_FILE_TOOL, LIST_FILES_TOOL, BASH_TOOL],
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
      } else {
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          switch (call.function.name) {
            case "read_file":
              result = await readFileTool(args, cwd);
              break;
            case "list_files":
              result = await listFilesTool(args, cwd);
              break;
            case "bash":
              result = await bashTool(args, cwd, confirmBash);
              break;
            default:
              result = `Error: unknown tool ${call.function.name}`;
          }
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
