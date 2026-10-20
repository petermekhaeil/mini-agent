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
      "Read raw text from a non-hidden file in the working directory. Optionally request a numbered line range with offset and limit.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the working directory",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-based starting line number; defaults to 1 when a range is requested.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional positive number of lines to return; defaults to all remaining lines.",
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
type ToolCall = NonNullable<ChatCompletionMessage["tool_calls"]>[number];

export interface RunAgentOptions {
  client: ChatClient;
  model: string;
  reasoningEffort?: ChatCompletionCreateParamsNonStreaming["reasoning_effort"];
  request: string;
  cwd?: string;
  maxTurns?: number;
  onTurnLimit?: () => Promise<boolean>;
  confirmBash?: ConfirmBash;
  confirmEdit?: ConfirmEdit;
  history?: ChatCompletionMessageParam[];
  meter?: TokenMeter;
  reportTokens?: (line: string) => void;
  reportWarning?: (line: string) => void;
}

const MAX_PROJECT_INSTRUCTION_CHARS = 8_000;

const SYSTEM_PROMPT = [
  "You are a coding assistant. Inspect the project, then answer the user's request.",
  "Use code_search, list_files, and read_file for read-only discovery. Use read_file offset and limit to inspect numbered line ranges instead of using sed for line ranges.",
  "When a command or edit would help, call bash or edit_file directly instead of asking approval in chat.",
  "Change files only through approved bash or edit_file calls. Never retry a denied action.",
].join(" ");

async function buildSystemPrompt(
  cwd: string,
  reportWarning: (line: string) => void = console.error,
): Promise<string> {
  try {
    const loadedInstructions = await readConfinedFile("AGENT.md", cwd);
    const truncated = loadedInstructions.length > MAX_PROJECT_INSTRUCTION_CHARS;
    const projectInstructions = truncated
      ? loadedInstructions.slice(0, MAX_PROJECT_INSTRUCTION_CHARS)
      : loadedInstructions;
    if (truncated) {
      reportWarning(`AGENT.md exceeds ${MAX_PROJECT_INSTRUCTION_CHARS} characters; using only the first ${MAX_PROJECT_INSTRUCTION_CHARS}.`);
    }
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

/** Run a bounded tool loop; interactive callers can approve another batch of turns. */
export async function runAgent({
  client,
  model,
  reasoningEffort,
  request,
  cwd = process.cwd(),
  maxTurns = 25,
  onTurnLimit,
  confirmBash = async () => false,
  confirmEdit = async () => false,
  history,
  meter = new TokenMeter(),
  reportTokens,
  reportWarning,
}: RunAgentOptions): Promise<{ answer: string; messages: ChatCompletionMessageParam[]; stopped?: boolean }> {
  const messages: ChatCompletionMessageParam[] = history?.length
    ? [...history, { role: "user", content: request }]
    : [
        { role: "system", content: await buildSystemPrompt(cwd, reportWarning) },
        { role: "user", content: request },
      ];

  let turns = 0;
  const atTurnLimit = async (): Promise<boolean> => {
    if (turns >= maxTurns) {
      if (!onTurnLimit) throw new Error(`Agent stopped after ${maxTurns} turns without a final answer`);
      if (!(await onTurnLimit())) return true;
      turns = 0;
    }
    return false;
  };

  const callModel = async (
    conversation: ChatCompletionMessageParam[],
  ): Promise<ChatCompletionMessage> => {
    const response = await client.chat.completions.create({
      model,
      messages: conversation,
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
    conversation.push(assistant);
    return assistant;
  };

  const toolFunctions: Record<string, (args: unknown) => Promise<string>> = {
    read_file: (args) => readFileTool(args, cwd),
    list_files: (args) => listFilesTool(args, cwd),
    code_search: (args) => codeSearchTool(args, cwd),
    bash: (args) => bashTool(args, cwd, confirmBash),
    edit_file: (args) => editFileTool(args, cwd, confirmEdit),
  };

  const executeTool = async (call: ToolCall): Promise<ChatCompletionMessageParam> => {
    let result: string;

    if (call.type !== "function") {
      result = "Error: unsupported custom tool call";
    } else {
      try {
        const args: unknown = JSON.parse(call.function.arguments);
        const tool = Object.hasOwn(toolFunctions, call.function.name)
          ? toolFunctions[call.function.name]
          : undefined;
        result = tool
          ? await tool(args)
          : `Error: unknown tool ${call.function.name}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = `Error: ${message}`;
      }
    }

    return {
      role: "tool",
      tool_call_id: call.id,
      content: result,
    };
  };

  while (true) {
    if (await atTurnLimit()) return { answer: "", messages, stopped: true };
    turns++;
    const assistant = await callModel(messages);
    if (!assistant.tool_calls?.length) return { answer: assistant.content ?? "", messages };
    for (const call of assistant.tool_calls) {
      messages.push(await executeTool(call));
    }
  }
}
