import type { ChatClient } from "./llm";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { listFilesTool } from "./tools/list";
import { readConfinedFile, readFileTool } from "./tools/read";
import { bashTool, type ConfirmBash } from "./tools/bash";
import { editFileTool, type ConfirmEdit } from "./tools/edit";
import { codeSearchTool } from "./tools/search";
import { TokenMeter, formatTokenCall } from "./tokens";

export const READ_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "read_file",
    description:
      "Read raw text from a non-hidden file in the working directory.",
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

export const CODE_SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "code_search",
    description: "Search repository files with a regular expression using ripgrep. Read-only and confined to the working directory.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Non-empty regular expression to search for" },
        path: { type: "string", description: "File or directory relative to the working directory; defaults to the project root" },
        glob: { type: "string", description: "Optional ripgrep glob to filter files, such as *.ts" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

export const BASH_TOOL = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Run a shell command in the working directory. Call this tool directly when useful; it requests terminal approval before running.",
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

export const EDIT_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "edit_file",
    description: "Replace one exact, unique text occurrence in an existing UTF-8 text file. Call this tool directly when useful; it requests terminal approval before editing.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        old_str: { type: "string", description: "Non-empty exact existing text to replace" },
        new_str: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_str", "new_str"],
      additionalProperties: false,
    },
  },
};

export type Message = ChatCompletionMessageParam | ChatCompletionMessage;

export interface RunAgentOptions {
  client: ChatClient;
  model: string;
  reasoningEffort?: ChatCompletionCreateParamsNonStreaming["reasoning_effort"];
  request: string;
  cwd?: string;
  maxTurns?: number;
  confirmBash?: ConfirmBash;
  confirmEdit?: ConfirmEdit;
  history?: ChatCompletionMessageParam[];
  meter?: TokenMeter;
  reportTokens?: (line: string) => void;
}

const SYSTEM_PROMPT = [
  "You are a coding assistant. Inspect the project, then answer the user's request.",
  "Use code_search, list_files, and read_file for read-only discovery.",
  "When a command or edit would help, call bash or edit_file directly instead of asking approval in chat.",
  "Change files only through approved bash or edit_file calls. Never retry a denied action.",
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
export async function runAgent({
  client,
  model,
  reasoningEffort,
  request,
  cwd = process.cwd(),
  maxTurns = 25,
  confirmBash = async () => false,
  confirmEdit = async () => false,
  history,
  meter = new TokenMeter(),
  reportTokens,
}: RunAgentOptions): Promise<{ answer: string; messages: ChatCompletionMessageParam[] }> {
  const messages: ChatCompletionMessageParam[] = history?.length
    ? [...history, { role: "user", content: request }]
    : [
        { role: "system", content: await buildSystemPrompt(cwd) },
        { role: "user", content: request },
      ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: [READ_FILE_TOOL, LIST_FILES_TOOL, CODE_SEARCH_TOOL, BASH_TOOL, EDIT_FILE_TOOL],
      tool_choice: "auto",
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    });
    const recorded = meter.record(response.usage);
    reportTokens?.(formatTokenCall(recorded, meter.totals.total));
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
            case "code_search":
              result = await codeSearchTool(args, cwd);
              break;
            case "bash":
              result = await bashTool(args, cwd, confirmBash);
              break;
            case "edit_file":
              result = await editFileTool(args, cwd, confirmEdit);
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
