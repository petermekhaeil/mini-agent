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
  provider: Provider;
  reasoningEffort?: ChatCompletionCreateParamsNonStreaming["reasoning_effort"];
};

export type Provider = "openai" | "xai";

const providerConfig: Record<Provider, { apiKey: string; defaultModel: string; baseURL?: string }> = {
  openai: { apiKey: "OPENAI_API_KEY", defaultModel: "gpt-6-luna" },
  xai: { apiKey: "XAI_API_KEY", defaultModel: "grok-4.7", baseURL: "https://api.x.ai/v1" },
};

export function createChatClient(
  env: Record<string, string | undefined> = process.env,
): ClientConfig {
  const selectedProvider = env.AGENT_PROVIDER ?? "openai";
  if (!Object.hasOwn(providerConfig, selectedProvider)) {
    throw new Error(`Unknown AGENT_PROVIDER ${JSON.stringify(selectedProvider)}. Choose openai or xai.`);
  }
  const provider = selectedProvider as Provider;
  const config = providerConfig[provider];
  const apiKey = env[config.apiKey];
  if (!apiKey) throw new Error(`${config.apiKey} is required for provider ${provider}`);
  const model = env.AGENT_MODEL === undefined ? config.defaultModel : env.AGENT_MODEL.trim();
  if (!model) throw new Error("AGENT_MODEL must be a non-empty model name");

  return {
    client: new OpenAI({ apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) }),
    model,
    provider,
    ...(provider === "openai" && model === "gpt-6-luna" ? { reasoningEffort: "none" as const } : {}),
  };
}
