import type { RepoConfig } from "./companies.js";
import { redact, repoAccess } from "./git.js";

export interface PrInput {
  branch: string;
  title: string;
  body: string;
}

async function call(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok && res.status !== 422) {
    throw new Error(redact(`${init.method} ${url} → ${res.status}: ${(await res.text()).slice(0, 400)}`));
  }
  return res;
}

async function githubPr(repo: RepoConfig, pr: PrInput): Promise<string> {
  const { token, apiBase, reviewer } = repoAccess(repo);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const base = `${apiBase}/repos/${repo.path}`;
  const payload = { title: pr.title, head: pr.branch, base: repo.default_branch, body: pr.body };

  let res = await call(`${base}/pulls`, { method: "POST", headers, body: JSON.stringify({ ...payload, draft: true }) });
  if (res.status === 422) {
    const first = await res.text();
    if (!/draft/i.test(first)) throw new Error(`GitHub PR failed: ${first.slice(0, 400)}`);
    res = await call(`${base}/pulls`, { method: "POST", headers, body: JSON.stringify({ ...payload, title: `[WIP] ${pr.title}` }) });
    if (res.status === 422) throw new Error(`GitHub PR failed: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as { html_url: string; number: number };

  if (reviewer) {
    await fetch(`${base}/pulls/${data.number}/requested_reviewers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewers: [reviewer] }),
    }).catch(() => undefined);
  }
  return data.html_url;
}

async function gitlabMr(repo: RepoConfig, pr: PrInput): Promise<string> {
  const { token, apiBase } = repoAccess(repo);
  const res = await call(`${apiBase}/projects/${encodeURIComponent(repo.path)}/merge_requests`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    body: JSON.stringify({
      source_branch: pr.branch,
      target_branch: repo.default_branch,
      title: `Draft: ${pr.title}`,
      description: pr.body,
      remove_source_branch: true,
    }),
  });
  if (res.status === 422) throw new Error(`GitLab MR failed: ${(await res.text()).slice(0, 400)}`);
  const data = (await res.json()) as { web_url: string };
  return data.web_url;
}

export function openPullRequest(repo: RepoConfig, pr: PrInput): Promise<string> {
  return repo.provider === "github" ? githubPr(repo, pr) : gitlabMr(repo, pr);
}
