import "dotenv/config";
import path from "node:path";

function req(name: string, hint = "see .env.example"): string {
  const v = process.env[name]?.trim(); // a stray space after "=" in .env would break auth
  if (!v) throw new Error(`Missing required env var ${name} (${hint})`);
  return v;
}
const opt = (name: string, fallback = "") => process.env[name] ?? fallback;

const dataDir = path.resolve(opt("DATA_DIR", "./data"));

const authMode = opt("AUTH_MODE", "subscription");
if (authMode !== "subscription" && authMode !== "api") {
  throw new Error(`AUTH_MODE must be "subscription" or "api", got "${authMode}"`);
}

/** Global settings only. Everything per-company lives in companies.yaml. */
export const config = {
  // subscription: your Claude Pro/Max plan via `claude setup-token`. api: pay-as-you-go API key.
  authMode: authMode as "subscription" | "api",
  claudeOauthToken:
    authMode === "subscription"
      ? req("CLAUDE_CODE_OAUTH_TOKEN", "run `claude setup-token` and add the token to .env, or set AUTH_MODE=api")
      : "",
  anthropicKey: authMode === "api" ? req("ANTHROPIC_API_KEY", "AUTH_MODE=api needs an API key") : "",
  // Empty = let the CLI pick your plan's default model.
  models: {
    triage: opt("TRIAGE_MODEL"),
    agent: opt("AGENT_MODEL"),
  },
  agentMaxTurns: Number(opt("AGENT_MAX_TURNS", "60")),
  agentMaxBudgetUsd: Number(opt("AGENT_MAX_BUDGET_USD", "3")), // api mode only
  taskTimeoutMs: Number(opt("TASK_TIMEOUT_MINUTES", "30")) * 60_000,
  autoStart: opt("AUTO_START") === "true",
  gitAuthor: {
    name: opt("GIT_AUTHOR_NAME", "BackendBot"),
    email: opt("GIT_AUTHOR_EMAIL", "backendbot@users.noreply.github.com"),
  },
  dataDir,
  dbPath: path.join(dataDir, "backendbot.db"),
  workDir: path.join(dataDir, "work"),
  companiesFile: path.resolve(opt("COMPANIES_FILE", "./companies.yaml")),
};
