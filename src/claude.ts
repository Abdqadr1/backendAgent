import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { redact } from "./git.js";

/** The single JSON object `claude -p --output-format json` prints. Field names checked against CLI 2.1.222. */
export interface ClaudeResult {
  type?: string;            // "result"
  subtype?: string;         // "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution"
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  api_error_status?: number | null;
  terminal_reason?: string;
}

export interface ClaudeRun {
  exitCode: number | null;
  timedOut: boolean;
  json: ClaudeResult | null;
  stdout: string;
  stderr: string;
}

export const USAGE_LIMIT_MESSAGE = "Claude usage limit reached; tap Go to retry later";

/**
 * Built from scratch, never inherited: only what the CLI needs to run and authenticate.
 * Slack, Jira, GitHub and GitLab tokens never reach it. Only one Claude credential is passed,
 * because having both set causes auth conflicts.
 */
function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    DISABLE_AUTOUPDATER: "1",
  };
  if (config.authMode === "subscription") env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOauthToken;
  else env.ANTHROPIC_API_KEY = config.anthropicKey;
  return env;
}

/** Flags every call uses: JSON out, never prompt, ignore the repo's own settings/hooks/MCP, no session files. */
export const BASE_FLAGS = [
  "--output-format", "json",
  "--permission-mode", "dontAsk",
  "--setting-sources", "user",
  "--strict-mcp-config",
  "--no-session-persistence",
];

export const modelFlag = (model: string) => (model ? ["--model", model] : []);

/** Run `claude -p <prompt> ...flags` without a shell. Killed with SIGTERM, then SIGKILL, on timeout. */
export function runClaude(prompt: string, flags: string[], cwd: string, timeoutMs: number): Promise<ClaudeRun> {
  // The prompt comes right after -p so variadic flags like --tools can't swallow it.
  const args = ["-p", prompt, ...BASE_FLAGS, ...flags];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, timedOut, json: parseResult(stdout), stdout: redact(stdout), stderr: redact(stderr) });
    };
    child.on("error", (e) => {
      stderr += `failed to start claude: ${e.message}`;
      finish(null);
    });
    child.on("close", finish);
  });
}

function parseResult(stdout: string): ClaudeResult | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

const LIMIT_PATTERN = /usage limit|rate.?limit|limit reached|too many requests|overloaded/i;

/** Plan usage limit or API rate limit, from the JSON result, its HTTP status, or stderr. */
export function isUsageLimit(run: ClaudeRun): boolean {
  if (run.json?.api_error_status === 429) return true;
  const failed = run.exitCode !== 0 || run.json?.is_error;
  return Boolean(failed) && LIMIT_PATTERN.test(`${run.json?.result ?? ""}\n${run.stderr}\n${run.stdout.slice(0, 2000)}`);
}

/** Short, token-free description of why a run failed. */
export function describeFailure(run: ClaudeRun): string {
  if (run.timedOut) return "timed out";
  // Auth/API errors come back as is_error with subtype "success", so the result text is the useful part.
  if (run.json?.is_error && run.json.result) return run.json.result.slice(0, 300);
  if (run.json?.subtype && run.json.subtype !== "success") return run.json.subtype;
  const detail = run.stderr.trim() || run.stdout.trim();
  return `exit ${run.exitCode}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

/** An empty scratch directory outside any repo, removed by the caller. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backendbot-"));
}

/** Minimal call at startup so bad auth fails loudly instead of on the first task. */
export async function selfTest(): Promise<void> {
  const dir = tempDir();
  try {
    const run = await runClaude("Reply with exactly OK", ["--tools", "", "--max-turns", "1"], dir, 120_000);
    if (run.exitCode === 0 && run.json && !run.json.is_error) return;
    const how =
      config.authMode === "subscription"
        ? "Run `claude setup-token` on your machine (needs a Claude Pro/Max subscription), put the token in .env as " +
          "CLAUDE_CODE_OAUTH_TOKEN, then restart. Or set AUTH_MODE=api with ANTHROPIC_API_KEY."
        : "Check ANTHROPIC_API_KEY in .env, or switch to AUTH_MODE=subscription with CLAUDE_CODE_OAUTH_TOKEN.";
    const reason = isUsageLimit(run) ? USAGE_LIMIT_MESSAGE : describeFailure(run);
    throw new Error(`Claude CLI self-test failed (AUTH_MODE=${config.authMode}): ${reason}\n${how}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
