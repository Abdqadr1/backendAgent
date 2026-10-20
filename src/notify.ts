import { getCompany } from "./companies.js";
import { triageOf, updateTask } from "./db.js";
import { notifyWorkspace } from "./slackApps.js";
import type { AgentReport, Task } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bullets = (items: string[]) => items.map((i) => `• ${esc(i)}`).join("\n");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = { type: string; [key: string]: any };

const KIND_LABEL = { code: "Coding task", needs_info: "Needs more info", not_code: "Not a coding task" } as const;

function ws(task: Task) {
  const w = notifyWorkspace(task.company);
  if (!w) throw new Error(`No Slack workspace to notify for company ${task.company}`);
  return w;
}

function cardBlocks(task: Task): Block[] {
  const t = triageOf(task);
  const company = getCompany(task.company)?.name ?? task.company;
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*[${esc(company)}] ${t ? KIND_LABEL[t.kind] : "Task"}* · <${task.source_url}|${esc(task.jira_key ?? task.title.slice(0, 80))}>\nfrom ${esc(task.requester)} via ${task.source}`,
      },
    },
  ];
  if (t) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Summary:* ${esc(t.summary)}` } });
    if (t.plan.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Plan:*\n${bullets(t.plan)}` } });
    if (t.questions.length)
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Open questions:*\n${bullets(t.questions)}` } });
  }
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Repo:* ${task.repo ? `\`${task.repo}\`` : "_not sure, pick one below_"}${t?.repo_confidence === "low" && task.repo ? " _(low confidence)_" : ""}`,
    },
  });
  return blocks;
}

function actionBlock(task: Task): Block {
  // Only the task's own company's repos are offered.
  const repos = getCompany(task.company)?.repos ?? [];
  const options = repos.slice(0, 100).map((r) => ({
    text: { type: "plain_text", text: r.name },
    value: `${task.id}|${r.name}`,
  }));
  const select: Block = {
    type: "static_select",
    action_id: "task_repo",
    placeholder: { type: "plain_text", text: "Choose repo" },
    options,
  };
  const current = options.find((o) => o.value === `${task.id}|${task.repo}`);
  if (current) select.initial_option = current;
  return {
    type: "actions",
    elements: [
      select,
      { type: "button", action_id: "task_go", style: "primary", text: { type: "plain_text", text: "Go" }, value: task.id },
      { type: "button", action_id: "task_skip", text: { type: "plain_text", text: "Skip" }, value: task.id },
    ],
  };
}

const statusBlock = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

export async function sendApprovalCard(task: Task): Promise<void> {
  const w = ws(task);
  const res = await w.app.client.chat.postMessage({
    channel: w.myUserId,
    text: `New task: ${task.title}`,
    blocks: [...cardBlocks(task), actionBlock(task)],
  });
  updateTask(task.id, { dm_channel: res.channel ?? null, dm_ts: res.ts ?? null });
}

export async function refreshCard(task: Task): Promise<void> {
  if (!task.dm_channel || !task.dm_ts) return;
  await ws(task).app.client.chat.update({
    channel: task.dm_channel,
    ts: task.dm_ts,
    text: task.title,
    blocks: [...cardBlocks(task), actionBlock(task)],
  });
}

export async function setCardStatus(task: Task, status: string): Promise<void> {
  if (!task.dm_channel || !task.dm_ts) return;
  await ws(task).app.client.chat.update({
    channel: task.dm_channel,
    ts: task.dm_ts,
    text: task.title,
    blocks: [...cardBlocks(task), statusBlock(status)],
  });
}

export async function replyInThread(task: Task, text: string): Promise<void> {
  const w = ws(task);
  await w.app.client.chat.postMessage({
    channel: task.dm_channel ?? w.myUserId,
    thread_ts: task.dm_ts ?? undefined,
    text,
  });
}

export async function sendPrDone(task: Task, prUrl: string, report: AgentReport, cost: number): Promise<void> {
  const testIcon = report.tests === "passed" ? "✅" : report.tests === "failed" ? "❌" : "⚠️";
  const parts = [
    `*Draft PR ready:* <${prUrl}|open PR>`,
    esc(report.summary),
    report.changes.length ? `*Changes:*\n${bullets(report.changes)}` : "",
    `*Tests:* ${testIcon} ${esc(report.tests)}${report.tests_detail ? ` · ${esc(report.tests_detail)}` : ""}`,
    report.assumptions.length ? `*Assumptions to check:*\n${bullets(report.assumptions)}` : "",
    report.questions.length ? `*Questions:*\n${bullets(report.questions)}` : "",
    `_cost ≈ $${cost.toFixed(2)}_`,
  ].filter(Boolean);
  await replyInThread(task, parts.join("\n\n"));
  await setCardStatus(task, `✅ Draft PR open: <${prUrl}|${prUrl.split("/").slice(-3).join("/")}>`);
}
