import "dotenv/config";
import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}
const opt = (name: string, fallback = "") => process.env[name] ?? fallback;

const dataDir = path.resolve(opt("DATA_DIR", "./data"));

/** Global settings only. Everything per-company lives in companies.yaml. */
export const config = {
  anthropicKey: req("ANTHROPIC_API_KEY"),
  models: {
    triage: opt("TRIAGE_MODEL", "claude-sonnet-5-5"),
    agent: opt("AGENT_MODEL", "claude-sonnet-5-5"),
  },
  agentMaxTurns: Number(opt("AGENT_MAX_TURNS", "60")),
  agentMaxBudgetUsd: Number(opt("AGENT_MAX_BUDGET_USD", "3")),
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
