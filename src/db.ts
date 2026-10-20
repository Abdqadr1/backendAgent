import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config.js";
import type { NewTask, Task, TaskStatus, Triage } from "./types.js";

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  requester TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  jira_key TEXT,
  status TEXT NOT NULL,
  repo TEXT,
  triage TEXT,
  branch TEXT,
  pr_url TEXT,
  error TEXT,
  dm_channel TEXT,
  dm_ts TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_jira ON tasks(company, jira_key);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

// Upgrade a database created by the single-company version.
const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
if (!cols.includes("company")) db.exec(`ALTER TABLE tasks ADD COLUMN company TEXT NOT NULL DEFAULT ''`);

/** Inserts a task; returns false if a task with this id already exists. */
export function insertTask(t: NewTask): boolean {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, company, source, source_url, requester, title, body, jira_key, status, created_at, updated_at)
       VALUES (@id, @company, @source, @source_url, @requester, @title, @body, @jira_key, 'new', @now, @now)`,
    )
    .run({ ...t, now });
  return r.changes === 1;
}

const UPDATABLE = new Set([
  "status", "repo", "triage", "branch", "pr_url", "error", "dm_channel", "dm_ts", "cost_usd", "jira_key",
]);

export function updateTask(id: string, patch: Partial<Task>): void {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...Object.fromEntries(keys.map((k) => [k, (patch as Record<string, unknown>)[k] ?? null])),
    updated_at: new Date().toISOString(),
    id,
  });
}

export function getTask(id: string): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined;
}

/** Jira keys are only unique inside one company's Jira. */
export function taskForJiraKey(company: string, key: string): Task | undefined {
  return db
    .prepare(`SELECT * FROM tasks WHERE company = ? AND jira_key = ? ORDER BY created_at LIMIT 1`)
    .get(company, key) as Task | undefined;
}

export function tasksWithStatus(status: TaskStatus): Task[] {
  return db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at`).all(status) as Task[];
}

export function triageOf(task: Task): Triage | null {
  return task.triage ? (JSON.parse(task.triage) as Triage) : null;
}
