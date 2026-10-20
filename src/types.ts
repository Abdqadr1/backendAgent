export type TaskStatus =
  | "new"               // just captured
  | "awaiting_approval" // coding task, DM sent, waiting for Go
  | "needs_info"        // looks like code but too vague
  | "ignored"           // not a coding task
  | "approved"          // queued for the worker
  | "running"
  | "pr_open"
  | "failed"
  | "skipped";          // you tapped Skip

export interface Task {
  id: string;               // "slack:<company>:<channel>:<thread_ts>" or "jira:<company>:<KEY>"
  company: string;          // company id from companies.yaml
  source: "slack" | "jira";
  source_url: string;
  requester: string;
  title: string;
  body: string;             // full thread / ticket text (untrusted)
  jira_key: string | null;
  status: TaskStatus;
  repo: string | null;
  triage: string | null;    // JSON of Triage
  branch: string | null;
  pr_url: string | null;
  error: string | null;
  dm_channel: string | null;
  dm_ts: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export type NewTask = Pick<Task, "id" | "company" | "source" | "source_url" | "requester" | "title" | "body" | "jira_key">;

export interface Triage {
  kind: "code" | "needs_info" | "not_code";
  repo: string | null;
  repo_confidence: "high" | "low";
  summary: string;     // one sentence: what is being asked
  plan: string[];      // short steps
  questions: string[]; // what's unclear
}

export interface AgentReport {
  summary: string;
  changes: string[];
  assumptions: string[];
  questions: string[];
  tests: "passed" | "failed" | "none";
  tests_detail: string;
}
