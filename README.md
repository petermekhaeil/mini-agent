# mini-agent

I built this to see the coding-agent loop for myself. It uses Bun, TypeScript, and provider-specific Chat Completions APIs. It can list files, search code, read files, make user-approved text edits, and run user-approved shell commands.

## Run

Install ripgrep first (`brew install ripgrep` on macOS; `sudo apt install ripgrep` on Debian/Ubuntu). Then install dependencies, set a provider's API key, and ask a question:

```sh
bun install
rg --version
bun run start "Find the code that limits directory listings. How many paths can it return?"
```

`bun install` does not install `rg`; `code_search` requires the ripgrep executable on `PATH`.

| `AGENT_PROVIDER` | Required key | Default model |
| --- | --- | --- |
| `openai` (default) | `OPENAI_API_KEY` | `gpt-6-luna` |
| `xai` | `XAI_API_KEY` | `grok-4.7` |

Set the selected provider's key in your shell, then optionally override its model with `AGENT_MODEL` (must not be blank). For example:

```sh
AGENT_PROVIDER=xai bun run start "Explain this project"
```

The agent uses Chat Completions with tool calls; provider behavior and model capabilities can differ. OpenAI's `gpt-6-luna` needs `reasoning_effort: "none"` for tool calls on that API, so the agent sets it for that model. xAI marks Chat Completions as legacy. You can also pipe a request: `echo "Read README.md" | bun run start`.

Run `bun run start` with no arguments in a terminal to start a conversational REPL:

```text
You: Find where directory listings are limited.
Assistant: ...
You: /new
Conversation reset.
You: /exit
```

`/new` starts a fresh conversation (and reloads `AGENT.md` on the next request); `/exit` or Ctrl-D exits. Conversation history is only kept in memory until the process exits. Passing a request argument or piping stdin still runs one request and exits.

## Token meter

Each model call is recorded from the response's `prompt_tokens`, `completion_tokens`, and `prompt_tokens_details.cached_tokens` usage fields:

```text
[turn 1] ctx 4,210 (cached 3,900) · out 182 · total 4,392
[turn 2] ctx 4,380 (cached 4,100) · out 96 · total 8,868
```

`ctx` is the current call's input tokens, including conversation history. On turn 1, that includes the system prompt, tool definitions, and first user message; the count arrives after the response. It is not the context-window maximum or remaining space. `total` sums input and output tokens across calls, including repeated history. It is not a dollar bill.

In the REPL, `/tokens` uses `Bun.inspect.table()` to print a per-call table and session totals without making a model call. `/new` clears both conversation history and token totals. Unknown or missing usage fields appear as `n/a` (and make their corresponding totals unknown), never as zero. Cached tokens, when reported, are part of input tokens, not an additional amount; `0` means the provider reported zero cached tokens. Providers may omit cached-token counts, in which case the cached session total stays `n/a`. One-shot and piped requests use a fresh meter and keep the conversation answer on stdout; meter lines go to stderr.

Run it in a directory without secrets. `read_file` sends requested file contents and `code_search` sends matching lines to the selected provider. Conversation output stays on stdout; provider/model status, approvals, and token-meter lines/status stay on stderr. File paths are checked against the working directory, but approved shell commands can leave it and inherit environment variables, including provider API keys. Neither confirmation nor the working directory is a sandbox.

Before each `bash` command or `edit_file` change, the CLI shows what will run or change and asks for `y` or `Y`. Piped input cannot approve an action. `bash` uses blocking `Bun.spawnSync`, so it blocks the JavaScript event loop until the command exits or its 30-second timeout. The timeout sends `SIGKILL` to the shell process; child processes may survive. The tool truncates the returned text to 8,000 characters, but `spawnSync` captures full stdout and stderr first, so this is not a memory limit.

## How it works

```mermaid
sequenceDiagram
    participant User
    participant CLI as src/cli.ts
    participant Agent as src/loop.ts
    participant OpenAI
    participant Tools as list_files / read_file / code_search / edit_file / bash

    User->>CLI: Request (interactive, argument, or piped input)
    CLI->>Agent: runAgent(options with request and optional history)
    loop Until final answer (max 25 model turns per request)
        Agent->>OpenAI: Messages + tool descriptions
        OpenAI-->>Agent: Assistant message
        Agent->>Agent: Keep full assistant message
        opt Assistant requests tools
            loop For each tool call
                Agent->>Tools: Run arguments (bash/edit_file require approval)
                Tools-->>Agent: Result or error
                Agent->>Agent: Append result with matching tool_call_id
            end
        end
    end
    Agent-->>CLI: Answer + updated history
    CLI-->>User: Print final answer
    Note over User,CLI: REPL repeats this cycle with history; /new clears it. One-shot runs once.
```

In the REPL, each request uses the conversation history, so later requests can refer to earlier turns; `/new` clears that history. `src/loop.ts` keeps the full assistant tool call in the conversation. Each result goes back with the same `tool_call_id`, so OpenAI knows which call it answers.

- `list_files` returns up to 200 paths. It skips `.git`, `node_modules`, and symlinks, and stops walking when it finds a 201st file.
- `read_file` returns raw text and stays inside the working directory, limiting results to 8,000 characters.
- `code_search` uses ripgrep regexes in a file or directory (the project root by default), with an optional glob. Paths resolve inside the working directory; results include file and line numbers, capped at 100 lines and 8,000 characters.
- `edit_file` replaces one unique, exact text occurrence in an existing UTF-8 file after showing the target and full old/new strings for approval. The target must resolve inside the working directory and be a regular file. File creation is not supported.
- `bash` runs `/bin/bash -c` after approval. It returns the exit code and separate stdout and stderr, or a denial, signal, or timeout message. Its returned text is capped at 8,000 characters after capture.

For example, ask the agent: `Search src for TODO comments in TypeScript files` to have it call `code_search` with a pattern, path, and glob.

If there is an `AGENT.md` in the working directory, the loop adds it to each new conversation's system prompt. The CLI handles one request at a time. Approved shell commands can still change files; see [BACKLOG.md](BACKLOG.md) for edit race and write-failure limitations.

## Check it

Run `bun test` and `bunx tsc --noEmit`. See [BACKLOG.md](BACKLOG.md) for deferred improvements.
