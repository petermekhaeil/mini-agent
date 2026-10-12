import path from "node:path";

export type ConfirmBash = (command: string, cwd: string) => Promise<boolean>;

export const BASH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 8_000;

function parseCommand(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  const command = (value as Record<string, unknown>).command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("command must be a non-empty string");
  }
  return command;
}

export async function bashTool(
  value: unknown,
  cwd: string,
  confirm: ConfirmBash = async () => false,
  timeoutMs = BASH_TIMEOUT_MS,
): Promise<string> {
  let command: string;
  try {
    command = parseCommand(value);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const absoluteCwd = path.resolve(cwd);
  try {
    if ((await confirm(command, absoluteCwd)) !== true) {
      return "Command denied; it was not run. Do not retry without user approval.";
    }
  } catch (error) {
    return `Error: command approval failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    const result = Bun.spawnSync(["/bin/bash", "-c", command], {
      cwd: absoluteCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const status = result.exitedDueToTimeout
      ? `Timed out after ${timeoutMs} ms (SIGKILL).`
      : result.exitCode !== null
        ? `Exit code: ${result.exitCode}.`
        : `Terminated by signal ${result.signalCode ?? "unknown"}.`;
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const prefix = `${status}\nstdout:\n`;
    const separator = "\nstderr:\n";
    const full = `${prefix}${stdout}${separator}${stderr}`;
    if (full.length <= MAX_RESPONSE_CHARS) return full;

    const budget = MAX_RESPONSE_CHARS - prefix.length - separator.length - 40;
    const shownStdout = stdout.slice(0, budget);
    const shownStderr = stderr.slice(0, Math.max(0, budget - shownStdout.length));
    const omitted = stdout.length + stderr.length - shownStdout.length - shownStderr.length;
    return `${prefix}${shownStdout}${separator}${shownStderr}\n[truncated ${omitted} chars]`;
  } catch (error) {
    return `Error: could not run command: ${error instanceof Error ? error.message : String(error)}`;
  }
}
