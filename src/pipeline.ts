import { config } from "./config.js";
import { getTask, updateTask } from "./db.js";
import { sendApprovalCard, setCardStatus } from "./notify.js";
import { triageTask } from "./triage.js";
import { enqueue } from "./worker.js";

/** Called once for every newly captured task (Slack or Jira). */
export async function onNewTask(id: string): Promise<void> {
  const task = getTask(id);
  if (!task || task.status !== "new") return;

  let triage;
  try {
    triage = await triageTask(task);
  } catch (e) {
    console.error(`[triage] ${id} failed:`, e);
    updateTask(id, { status: "failed", error: `triage failed: ${(e as Error).message}` });
    return;
  }

  if (triage.kind === "not_code") {
    updateTask(id, { status: "ignored", triage: JSON.stringify(triage), repo: triage.repo });
    console.log(`[triage] ${id} → not a coding task: ${triage.summary}`);
    return;
  }

  updateTask(id, {
    status: triage.kind === "code" ? "awaiting_approval" : "needs_info",
    triage: JSON.stringify(triage),
    repo: triage.repo,
  });
  console.log(`[triage] ${id} → ${triage.kind} (${triage.repo ?? "no repo"}, ${triage.repo_confidence})`);
  await sendApprovalCard(getTask(id)!);

  const canAutoStart = config.autoStart && triage.kind === "code" && triage.repo && triage.repo_confidence === "high";
  if (canAutoStart) {
    updateTask(id, { status: "approved" });
    await setCardStatus(getTask(id)!, "⏳ Auto-started (AUTO_START=true)");
    enqueue(id);
  }
}
