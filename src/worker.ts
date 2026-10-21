import fs from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.js";
import { USAGE_LIMIT_MESSAGE } from "./claude.js";
import { config } from "./config.js";
import { getTask, tasksWithStatus, triageOf, updateTask } from "./db.js";
import { authUrl, cleanUrl, sh } from "./git.js";
import { replyInThread, sendPrDone, setCardStatus } from "./notify.js";
import { openPullRequest } from "./providers.js";
import { getCompany, getRepo } from "./companies.js";
import type { AgentReport, Task } from "./types.js";

// One task at a time: predictable cost and plan usage, and you review one PR at a time anyway.
const queue: string[] = [];
let busy = false;

export function enqueue(id: string): void {
  if (!queue.includes(id)) queue.push(id);
  void drain();
}

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await runTask(id);
      } catch (e) {
        await fail(id, (e as Error).message);
      }
    }
  } finally {
    busy = false;
  }
}

/** On startup: re-queue approved tasks; mark tasks that were mid-run as failed. */
export function recoverQueue(): void {
  for (const t of tasksWithStatus("running")) updateTask(t.id, { status: "failed", error: "interrupted by restart" });
  for (const t of tasksWithStatus("approved")) enqueue(t.id);
}

function branchName(task: Task, summary: string): string {
  const slug = (task.jira_key ? `${task.jira_key}-` : "") + summary;
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `agent/${clean || "task"}-${Date.now().toString(36).slice(-4)}`;
}

async function fail(id: string, message: string): Promise<void> {
  console.error(`[worker] ${id} failed: ${message}`);
  updateTask(id, { status: "failed", error: message });
  const task = getTask(id);
  if (!task) return;
  await replyInThread(task, `❌ Failed: ${message}\nTap *Go* again to retry.`).catch(() => undefined);
  await setCardStatus(task, "❌ Failed (see thread)").catch(() => undefined);
}

async function runTask(id: string): Promise<void> {
  const task = getTask(id);
  if (!task || task.status !== "approved") return;
  const repo = getRepo(task.company, task.repo);
  if (!repo) throw new Error(`Unknown repo "${task.repo}" for company ${task.company}`);
  const triage = triageOf(task);
  const branch = branchName(task, triage?.summary ?? task.title);

  updateTask(id, { status: "running", branch, error: null });
  await setCardStatus(getTask(id)!, `🛠️ Working in \`${repo.name}\` (${getCompany(repo.company)?.name}) on \`${branch}\`…`);
  console.log(`[worker] ${id} → ${repo.name} @ ${branch}`);

  // Per-company workspace folders: nothing from one company's clone sits next to another's.
  const dir = path.join(config.workDir, task.company, `${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  try {
    // 1. Fresh clone; strip credentials from the remote so the agent never sees a token.
    sh("git", ["clone", "--depth", "50", "--branch", repo.default_branch, authUrl(repo), dir]);
    sh("git", ["remote", "set-url", "origin", cleanUrl(repo)], dir);
    sh("git", ["config", "user.name", config.gitAuthor.name], dir);
    sh("git", ["config", "user.email", config.gitAuthor.email], dir);
    sh("git", ["checkout", "-b", branch], dir);

    // 2. Let the agent plan, code, test, and commit.
    const run = await runAgent(dir, task, triage, repo, branch);
    // On a subscription the CLI's cost figure is notional, so it's only recorded in api mode.
    const costUsd = config.authMode === "api" ? run.costUsd : 0;
    updateTask(id, { cost_usd: costUsd });
    // Out of plan usage: stop here without pushing half-done work. Not retried automatically.
    if (run.limitHit) throw new Error(USAGE_LIMIT_MESSAGE);

    // 3. Commit anything it left uncommitted.
    if (sh("git", ["status", "--porcelain"], dir)) {
      sh("git", ["add", "-A"], dir);
      sh("git", ["commit", "-m", `chore(agent): ${(triage?.summary ?? task.title).slice(0, 60)}`], dir);
    }
    const commits = Number(sh("git", ["rev-list", "--count", `origin/${repo.default_branch}..HEAD`], dir));
    if (commits === 0) {
      throw new Error(`no changes were made. ${run.error ? `Agent stopped: ${run.error}. ` : ""}${run.report.summary}`);
    }

    // 4. Push with credentials passed only on this command line.
    sh("git", ["push", authUrl(repo), `HEAD:refs/heads/${branch}`], dir);

    // 5. Draft PR / MR.
    const prUrl = await openPullRequest(repo, {
      branch,
      title: prTitle(task, triage?.summary ?? task.title, run.ok && run.report.tests !== "failed"),
      body: prBody(task, run.report, run.ok ? undefined : run.error),
    });

    updateTask(id, { status: "pr_open", pr_url: prUrl });
    await sendPrDone(getTask(id)!, prUrl, run.report, { costUsd, turns: run.turns });
    console.log(`[worker] ${id} → ${prUrl} (${config.authMode === "api" ? `$${costUsd.toFixed(2)}` : `${run.turns} turns`})`);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // Keep the working dir on failure so you can inspect it.
    throw new Error(`${(e as Error).message} (workspace kept at ${dir})`);
  }
}

function prTitle(task: Task, summary: string, healthy: boolean): string {
  const t = `${task.jira_key ? `${task.jira_key}: ` : ""}${summary}`.slice(0, 100);
  return healthy ? t : `[needs attention] ${t}`;
}

function prBody(task: Task, r: AgentReport, stopReason?: string): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    `> 🤖 Opened by BackendBot from a ${task.source === "jira" ? "Jira ticket" : "Slack thread"}. Review before merging.`,
    "",
    `**Request:** [${task.jira_key ?? "Slack thread"}](${task.source_url}) from ${task.requester}`,
    "",
    "## Summary",
    r.summary,
    r.changes.length ? `\n## Changes\n${list(r.changes)}` : "",
    `\n## Tests\n**${r.tests}**${r.tests_detail ? `: ${r.tests_detail}` : ""}`,
    r.assumptions.length ? `\n## Assumptions to verify\n${list(r.assumptions)}` : "",
    r.questions.length ? `\n## Open questions\n${list(r.questions)}` : "",
    stopReason ? `\n> ⚠️ The agent stopped early (${stopReason}). This work may be incomplete.` : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
}
