import type { ChatCompletion } from "openai/resources/chat/completions";

export type TokenEntry = {
  turn: number;
  prompt: number | null;
  cached: number | null;
  completion: number | null;
};

type Usage = ChatCompletion["usage"];

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sum(entries: TokenEntry[], field: "prompt" | "cached" | "completion"): number | null {
  let total = 0;
  for (const entry of entries) {
    const value = entry[field];
    if (value === null) return null;
    total += value;
  }
  return total;
}

const number = (value: number | null) => value === null ? "n/a" : value.toLocaleString("en-US");

export class TokenMeter {
  private entries: TokenEntry[] = [];

  record(usage: Usage | null | undefined): TokenEntry {
    const details = usage?.prompt_tokens_details;
    const entry: TokenEntry = {
      turn: this.entries.length + 1,
      prompt: readNumber(usage?.prompt_tokens),
      completion: readNumber(usage?.completion_tokens),
      cached: readNumber(details?.cached_tokens),
    };
    this.entries.push(entry);
    return entry;
  }

  get turns(): readonly TokenEntry[] { return this.entries; }

  get totals() {
    const prompt = sum(this.entries, "prompt");
    const cached = sum(this.entries, "cached");
    const completion = sum(this.entries, "completion");
    return { prompt, cached, completion, total: prompt === null || completion === null ? null : prompt + completion };
  }

  reset(): void {
    this.entries = [];
  }
}

export function formatTokenCall(entry: TokenEntry, sessionTotal: number | null = null): string {
  return `[turn ${entry.turn}] ctx ${number(entry.prompt)} (cached ${number(entry.cached)}) · out ${number(entry.completion)} · total ${number(sessionTotal)}`;
}

export function formatTokenReport(meter: TokenMeter): string {
  const rows = meter.turns.length
    ? [
        "Tokens per model call (left column = turn):",
        Bun.inspect.table(Object.fromEntries(meter.turns.map((entry) => [entry.turn, {
          ctx: number(entry.prompt),
          cached: number(entry.cached),
          out: number(entry.completion),
        }]))).trimEnd(),
      ]
    : ["No model calls yet."];
  const totals = meter.totals;
  rows.push(`Session totals: in ${number(totals.prompt)} (cached ${number(totals.cached)}) · out ${number(totals.completion)} · total ${number(totals.total)}`);
  return `${rows.join("\n")}\n`;
}
