import { companies, type Company } from "../companies.js";
import { insertTask, taskForJiraKey } from "../db.js";
import { onNewTask } from "../pipeline.js";

// Jira Cloud descriptions/comments are Atlassian Document Format (ADF). Flatten to text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text ?? "@someone";
  const inner = (node.content ?? []).map(adfToText).join("");
  return ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow"].includes(node.type)
    ? inner + "\n"
    : inner;
}

async function pollOnce(company: Company): Promise<void> {
  const jira = company.jira!;
  const params = new URLSearchParams({
    jql: jira.jql,
    fields: "summary,description,comment,reporter,issuetype,priority",
    maxResults: "25",
  });
  const res = await fetch(`${jira.baseUrl}/rest/api/3/search/jql?${params}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${jira.email}:${jira.token}`).toString("base64"),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Jira search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as { issues?: any[] };

  for (const issue of data.issues ?? []) {
    const key: string = issue.key;
    if (taskForJiraKey(company.id, key)) continue;
    const f = issue.fields ?? {};
    const comments = (f.comment?.comments ?? [])
      .slice(-15)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => `${c.author?.displayName ?? "someone"}: ${adfToText(c.body).trim()}`)
      .join("\n");
    const body = [
      `Type: ${f.issuetype?.name ?? "?"} · Priority: ${f.priority?.name ?? "?"}`,
      "",
      adfToText(f.description).trim() || "(no description)",
      comments ? `\nComments:\n${comments}` : "",
    ].join("\n");

    const id = `jira:${company.id}:${key}`;
    const created = insertTask({
      id,
      company: company.id,
      source: "jira",
      source_url: `${jira.baseUrl}/browse/${key}`,
      requester: f.reporter?.displayName ?? "unknown",
      title: `${key}: ${f.summary ?? ""}`,
      body,
      jira_key: key,
    });
    if (created) {
      console.log(`[jira:${company.id}] captured ${key}`);
      await onNewTask(id);
    }
  }
}

export function startJiraPolling(): void {
  for (const company of companies) {
    if (!company.jira) continue;
    const tick = () => pollOnce(company).catch((e) => console.error(`[jira:${company.id}] poll failed:`, e.message));
    void tick();
    setInterval(tick, company.jira.pollMs);
    console.log(`[jira:${company.id}] polling ${company.jira.baseUrl} every ${company.jira.pollMs / 1000}s`);
  }
}
