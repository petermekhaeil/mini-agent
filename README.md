# mini-agent

A tiny Bun + TypeScript coding agent using the raw OpenAI Chat Completions API. It demonstrates one conversation: your request, an assistant `read_file` tool call, the raw file text returned as a tool result, and the assistant's final reply.

## Run

Install dependencies with `bun install`, then set your OpenAI API key and ask a question:

```sh
export OPENAI_API_KEY=...
bun run start "Read src/cli.ts and explain how input is handled"
```

You can also pipe a single request: `echo "Read README.md" | bun run start`.

The agent uses OpenAI. `OPENAI_API_KEY` is required, and `AGENT_MODEL` optionally overrides the default model (`gpt-4o-mini`). Keep credentials in your shell environment, never in this repository.

Only run it in a working directory without secrets: `read_file` can send any file inside that directory to OpenAI, and the CLI prints tool results to your terminal. A path boundary is not a secret-file filter.

## How it works

`src/loop.ts` starts with a stable read-only system prompt and appends `AGENT.md` from the working directory when present. It keeps each full assistant message, including tool-call IDs; the raw `read_file` result uses the matching ID so the model can continue and answer. The tool accepts only a path and returns up to 8,000 characters, with a truncation note when needed. Line numbering and range selection are deferred. The path is confined to the working directory, but that is not a secret-file filter. The loop is capped at 25 model turns. The CLI performs one request only; there is no autonomous mode or interactive shell.

Run tests with `bun test` and type-check with `bunx tsc --noEmit`.
