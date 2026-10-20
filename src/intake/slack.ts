import { getCompany, getRepo } from "../companies.js";
import { getTask, insertTask, taskForJiraKey, updateTask } from "../db.js";
import { refreshCard, setCardStatus } from "../notify.js";
import { onNewTask } from "../pipeline.js";
import { notifyWorkspace, type Workspace } from "../slackApps.js";
import { enqueue } from "../worker.js";

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Capture mentions of you in one company's Slack workspace. */
export function registerSlackIntake(ws: Workspace): void {
  const me = ws.myUserId;
  const company = ws.companyId;
  const names = new Map<string, string>();

  async function userName(id: string | undefined): Promise<string> {
    if (!id) return "unknown";
    if (names.has(id)) return names.get(id)!;
    try {
      const r = await ws.app.client.users.info({ user: id });
      const name = r.user?.real_name || r.user?.name || id;
      names.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  ws.app.event("message", async ({ event }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = event as any;
    if (e.subtype || !e.text || e.user === me || e.bot_id) return;
    const isDmToMe = e.channel_type === "im";
    if (!isDmToMe && !String(e.text).includes(`<@${me}>`)) return;

    const threadTs: string = e.thread_ts ?? e.ts;
    const id = `slack:${company}:${e.channel}:${threadTs}`;
    if (getTask(id)) return;

    const jiraKey = String(e.text).match(JIRA_KEY)?.[0] ?? null;
    if (jiraKey && taskForJiraKey(company, jiraKey)) {
      console.log(`[slack:${company}] ${id} refers to ${jiraKey}, already tracked; skipping duplicate`);
      return;
    }

    const [replies, link] = await Promise.all([
      ws.user.conversations.replies({ channel: e.channel, ts: threadTs, limit: 50 }),
      ws.user.chat.getPermalink({ channel: e.channel, message_ts: e.ts }),
    ]);
    const lines: string[] = [];
    for (const m of replies.messages ?? []) lines.push(`${await userName(m.user)}: ${m.text ?? ""}`);
    const requester = await userName(e.user);

    const created = insertTask({
      id,
      company,
      source: "slack",
      source_url: link.permalink ?? "",
      requester,
      title: String(e.text).replace(/<@[A-Z0-9]+>/g, "").trim().slice(0, 140) || "Slack request",
      body: lines.join("\n"),
      jira_key: jiraKey,
    });
    if (created) {
      console.log(`[slack:${company}] captured ${id} from ${requester}`);
      void onNewTask(id);
    }
  });
}

/**
 * Buttons on the DM cards in this workspace. A click only counts if it comes from you,
 * and only for tasks whose cards are actually posted in this workspace.
 */
export function registerSlackActions(ws: Workspace): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const owns = (body: any, id: string) => {
    const task = getTask(id);
    if (!task || body.user?.id !== ws.myUserId) return undefined;
    return notifyWorkspace(task.company) === ws ? task : undefined;
  };

  ws.app.action("task_go", async ({ ack, body, action }) => {
    await ack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const task = owns(body, (action as any).value);
    if (!task || !["awaiting_approval", "needs_info", "failed"].includes(task.status)) return;
    if (!getRepo(task.company, task.repo)) {
      await ws.app.client.chat.postMessage({ channel: ws.myUserId, thread_ts: task.dm_ts ?? undefined, text: "Pick a repo first, then tap Go." });
      return;
    }
    updateTask(task.id, { status: "approved", error: null });
    await setCardStatus(getTask(task.id)!, "⏳ Queued, starting soon…");
    enqueue(task.id);
  });

  ws.app.action("task_skip", async ({ ack, body, action }) => {
    await ack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const task = owns(body, (action as any).value);
    if (!task) return;
    updateTask(task.id, { status: "skipped" });
    await setCardStatus(getTask(task.id)!, "⏭️ Skipped");
  });

  ws.app.action("task_repo", async ({ ack, body, action }) => {
    await ack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (action as any).selected_option?.value as string | undefined;
    if (!value) return;
    const sep = value.lastIndexOf("|");
    const task = owns(body, value.slice(0, sep));
    const repo = value.slice(sep + 1);
    if (!task || !getRepo(task.company, repo)) return;
    updateTask(task.id, { repo });
    await refreshCard(getTask(task.id)!);
  });

  console.log(`[slack:${ws.companyId}] buttons active (${getCompany(ws.companyId)?.name})`);
}
