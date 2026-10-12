import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

export type ChatClient = {
  chat: {
    completions: {
      create(request: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
    };
  };
};

type ClientConfig = {
  client: OpenAI;
  model: string;
};

export function createChatClient(
  env: Record<string, string | undefined> = process.env,
): ClientConfig {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  return {
    client: new OpenAI({ apiKey }),
    model: env.AGENT_MODEL ?? "gpt-4o-mini",
  };
}
