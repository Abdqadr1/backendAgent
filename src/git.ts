import { execFileSync } from "node:child_process";
import { allSecrets, getCompany, type RepoConfig } from "./companies.js";

export function redact(s: string): string {
  let out = s;
  for (const sec of allSecrets()) out = out.split(sec).join("***");
  return out;
}

/** Run a command without a shell; errors never leak tokens. */
export function sh(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(redact(`${cmd} ${args.join(" ")} failed: ${err.stderr || err.message}`));
  }
}

/** Credentials and host for a repo, always from its own company. */
export function repoAccess(repo: RepoConfig): { token: string; host: string; apiBase: string; reviewer: string } {
  const company = getCompany(repo.company);
  if (!company) throw new Error(`Unknown company ${repo.company}`);
  if (repo.provider === "github") {
    const token = repo.token ?? company.github?.token;
    if (!token) throw new Error(`No GitHub token for ${repo.company}/${repo.name}`);
    return { token, host: "github.com", apiBase: "https://api.github.com", reviewer: company.github?.reviewer ?? "" };
  }
  const gl = company.gitlab;
  if (!gl) throw new Error(`No GitLab config for ${repo.company}/${repo.name}`);
  return { token: repo.token ?? gl.token, host: new URL(gl.url).host, apiBase: `${gl.url}/api/v4`, reviewer: "" };
}

export function cleanUrl(repo: RepoConfig): string {
  return `https://${repoAccess(repo).host}/${repo.path}.git`;
}

export function authUrl(repo: RepoConfig): string {
  const { token, host } = repoAccess(repo);
  const user = repo.provider === "github" ? "x-access-token" : "oauth2";
  return `https://${user}:${token}@${host}/${repo.path}.git`;
}
