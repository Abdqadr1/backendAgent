import fs from "node:fs";
import YAML from "yaml";
import { config } from "./config.js";
import type { Task } from "./types.js";

export interface RepoConfig {
  company: string;
  name: string;
  provider: "github" | "gitlab";
  path: string;
  default_branch: string;
  description?: string;
  jira_projects?: string[];
  slack_channels?: string[];
  keywords?: string[];
  /** Optional per-repo token (e.g. a second GitHub org inside the same company). */
  token?: string;
}

export interface SlackCreds { botToken: string; appToken: string; userToken: string; myUserId: string }
export interface JiraCreds { baseUrl: string; email: string; token: string; jql: string; pollMs: number }

export interface Company {
  id: string;
  name: string;
  slack?: SlackCreds;
  jira?: JiraCreds;
  github?: { token: string; reviewer: string };
  gitlab?: { token: string; url: string };
  /** Company whose Slack receives this company's cards, if this company has no Slack. */
  notifyVia?: string;
  repos: RepoConfig[];
}

const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done AND updated >= -15m ORDER BY updated DESC";

function fromEnv(varName: unknown, where: string): string {
  if (typeof varName !== "string" || !varName) throw new Error(`${where}: missing *_env setting`);
  const v = process.env[varName];
  if (!v) throw new Error(`${where}: env var ${varName} is not set in .env`);
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCompany(raw: any): Company {
  const id = String(raw?.id ?? "");
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Company id "${id}" must be lowercase letters, digits or dashes`);
  const where = `companies.yaml [${id}]`;
  const c: Company = { id, name: String(raw.name ?? id), repos: [], notifyVia: raw.notify_via };

  if (raw.slack) {
    c.slack = {
      botToken: fromEnv(raw.slack.bot_token_env, `${where} slack`),
      appToken: fromEnv(raw.slack.app_token_env, `${where} slack`),
      userToken: fromEnv(raw.slack.user_token_env, `${where} slack`),
      myUserId: String(raw.slack.my_user_id ?? ""),
    };
    if (!c.slack.myUserId) throw new Error(`${where} slack: my_user_id is required`);
  }
  if (raw.jira) {
    c.jira = {
      baseUrl: String(raw.jira.base_url ?? "").replace(/\/$/, ""),
      email: String(raw.jira.email ?? ""),
      token: fromEnv(raw.jira.token_env, `${where} jira`),
      jql: String(raw.jira.jql ?? DEFAULT_JQL),
      pollMs: Number(raw.jira.poll_seconds ?? 120) * 1000,
    };
    if (!c.jira.baseUrl || !c.jira.email) throw new Error(`${where} jira: base_url and email are required`);
  }
  if (raw.github) {
    c.github = { token: fromEnv(raw.github.token_env, `${where} github`), reviewer: String(raw.github.reviewer ?? "") };
  }
  if (raw.gitlab) {
    c.gitlab = {
      token: fromEnv(raw.gitlab.token_env, `${where} gitlab`),
      url: String(raw.gitlab.url ?? "https://gitlab.com").replace(/\/$/, ""),
    };
  }

  for (const r of raw.repos ?? []) {
    const repo: RepoConfig = { ...r, company: id, token: r.token_env ? fromEnv(r.token_env, `${where} repo ${r.name}`) : undefined };
    delete (repo as unknown as Record<string, unknown>).token_env;
    if (!repo.name || !repo.path || !repo.default_branch || !["github", "gitlab"].includes(repo.provider)) {
      throw new Error(`${where}: invalid repo entry ${JSON.stringify(r)}`);
    }
    if (repo.provider === "github" && !c.github && !repo.token) throw new Error(`${where}: repo ${repo.name} is on GitHub but no github token is configured`);
    if (repo.provider === "gitlab" && !c.gitlab) throw new Error(`${where}: repo ${repo.name} is on GitLab but no gitlab section is configured`);
    if (c.repos.some((x) => x.name === repo.name)) throw new Error(`${where}: duplicate repo name ${repo.name}`);
    c.repos.push(repo);
  }
  if (!c.repos.length) throw new Error(`${where}: no repos listed`);
  return c;
}

function load(): Company[] {
  const doc = YAML.parse(fs.readFileSync(config.companiesFile, "utf8")) as { companies?: unknown[] };
  const list = (doc?.companies ?? []).map(parseCompany);
  if (!list.length) throw new Error(`No companies in ${config.companiesFile}`);
  const ids = new Set<string>();
  for (const c of list) {
    if (ids.has(c.id)) throw new Error(`Duplicate company id ${c.id}`);
    ids.add(c.id);
  }
  for (const c of list) {
    if (c.slack) continue;
    if (!c.notifyVia) throw new Error(`Company ${c.id} has no slack section; set notify_via to a company whose Slack should get its cards`);
    if (!list.find((x) => x.id === c.notifyVia && x.slack)) throw new Error(`Company ${c.id}: notify_via "${c.notifyVia}" has no Slack configured`);
  }
  return list;
}

export const companies: Company[] = load();

export function getCompany(id: string | null | undefined): Company | undefined {
  return companies.find((c) => c.id === id);
}

/** Repos are always looked up inside one company: names can repeat across companies. */
export function getRepo(companyId: string, name: string | null | undefined): RepoConfig | undefined {
  return getCompany(companyId)?.repos.find((r) => r.name === name);
}

/** Rule-based hint before asking the model: Jira project, then Slack channel. */
export function hintRepo(task: Task): string | null {
  const company = getCompany(task.company);
  if (!company) return null;
  if (task.jira_key) {
    const project = task.jira_key.split("-")[0];
    const hit = company.repos.find((r) => r.jira_projects?.includes(project));
    if (hit) return hit.name;
  }
  if (task.source === "slack") {
    const channel = task.id.split(":")[2]; // slack:<company>:<channel>:<ts>
    const hit = company.repos.find((r) => r.slack_channels?.includes(channel));
    if (hit) return hit.name;
  }
  return null;
}

/** Every credential, for redacting error messages. */
export function allSecrets(): string[] {
  const out: string[] = [];
  out.push(config.claudeOauthToken, config.anthropicKey);
  for (const c of companies) {
    if (c.github) out.push(c.github.token);
    if (c.gitlab) out.push(c.gitlab.token);
    if (c.jira) out.push(c.jira.token);
    for (const r of c.repos) if (r.token) out.push(r.token);
  }
  return out.filter(Boolean);
}
