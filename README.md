# BackendBot

Your personal coding agent, across every company you work with. When you're mentioned in Slack or assigned a Jira ticket, it works out
whether it's a coding task and which repo it belongs to, then DMs you a plan. When you tap **Go**,
it clones the repo into a fresh workspace, creates its own `agent/...` branch, writes the code and
tests, opens a **draft** PR (GitHub) or MR (GitLab), and DMs you the link.

```
Slack mention / Jira assignment
   → capture task (SQLite, deduped by thread / ticket key)
   → triage: coding? which repo? plan?
   → DM you: summary · plan · repo picker · [Go] [Skip]
   → on Go: fresh clone → agent/<branch> → Claude Agent SDK codes + runs tests → commit
   → push → draft PR/MR → DM you the link + what to check
```

## Multiple companies
Everything is organised by **company** in `companies.yaml`. Each company has its own Slack workspace,
Jira site, GitHub/GitLab tokens and repo list. Secrets stay in `.env`, and the YAML only names them (`*_env`).

What stays separate between companies:
- **Triage:** a task only ever sees its own company's repos, so it can't be routed to another client's code.
- **Cards:** posted in the company's own Slack. If a company has no Slack, you must explicitly choose
  another workspace with `notify_via`.
- **Git:** each clone and push uses that company's token. Workspaces live under `data/work/<company>/`.
- **Jira:** keys are tracked per company, so `PAY-12` at Arebak and `PAY-12` at a client never collide.
- **Buttons:** a click only acts on tasks whose card lives in that workspace, and only if it comes from you.

> Before connecting a company, check that its policy (or your contract) allows sending its code and
> tickets to an AI provider. Some clients forbid it.

## Setup, per company

### 1. Slack (one app per workspace)
For **each** company workspace you're in:
1. https://api.slack.com/apps → **Create New App → From a manifest** → pick that workspace → paste `slack-app-manifest.yaml`.
2. **Install App → Install to Workspace.** Copy the **Bot** token (`xoxb-`) and **User** token (`xoxp-`).
   If you see "Request to Install", a workspace admin must approve it first.
3. **Basic Information → App-Level Tokens** → create one with `connections:write` (`xapp-`).
4. Your member ID **in that workspace**: profile → ⋮ → **Copy member ID**. It's different in every workspace.

### 2. Jira (one token per Atlassian account)
Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens while logged in
with the email you use for that company's Jira.

### 3. Git tokens (one per GitHub org / GitLab instance)
- **GitHub:** a fine-grained token can only cover **one** owner (org). Create one per org, with resource owner =
  that org, *Only select repositories*, **Contents** and **Pull requests** set to read/write. If a company has
  repos in two orgs, set the second org's token on those repos with `token_env`.
- **GitLab:** one token per GitLab instance/account, scopes `api` + `write_repository`. Set `url` for self-hosted.

### 4. Configure and run
```bash
cp .env.example .env                      # add each company's secrets
cp companies.example.yaml companies.yaml  # companies, repos, and which env vars hold their secrets
docker compose up -d --build
docker compose logs -f
```
The bot checks the whole config at startup. A missing token or a bad repo entry stops it with a clear
message naming the company. You get a 🟢 DM in each workspace once it's online.

### 5. Teach it each repo
Add a `CLAUDE.md` at the root of each repo. Include how to build, lint and test, the folder layout,
the error-handling pattern, and one good example endpoint and test. The agent reads it automatically.
Add the toolchains your repos need (Go, Java…) to the `Dockerfile`.

## Safety model
- **Ask-first by default.** Nothing is coded until you tap Go. Only your Slack user ID can press the
  buttons. `AUTO_START=true` lets confident tasks start on their own. Turn it on only after a few weeks of good triage.
- **Request text is treated as data, not instructions,** in both the triage and agent prompts.
- **No secrets reach the agent.** Its environment is replaced with just `PATH`, `HOME` and the Anthropic key.
  The git remote has no token in it. Credentials are only passed directly to `git clone` and `git push`, which this program runs itself.
- **Blocked commands:** `git push`/`remote`, `curl`/`wget`/`ssh`, `docker`/`kubectl`/cloud CLIs, `sudo`, `rm -rf /`.
  Web tools are disabled.
- **Limits per task:** `AGENT_MAX_TURNS`, `AGENT_MAX_BUDGET_USD` (hard cost cap) and `TASK_TIMEOUT_MINUTES`.
- **Only `agent/*` branches and draft PRs.** It cannot merge or deploy. Protect your main branches as usual.
- **Only repos in `companies.yaml`.** Tasks run one at a time.

> The command blocklist is a guardrail, not a perfect sandbox. Run it in Docker, on a machine without
> production credentials, with tokens scoped only to the repos you list.

## Day to day
- Every task gets one DM card. Progress, the PR link, test results, assumptions and questions go in its thread.
- **Failed?** The reason is in the thread, and the workspace is kept under `data/work/` for inspection.
  Tap **Go** to retry.
- **Wrong repo?** Change it in the dropdown before tapping Go.
- To check what it captured: `sqlite3 data/backendbot.db "select company,id,status,repo,pr_url,cost_usd from tasks order by created_at desc limit 20"`

## Project layout
```
src/
  index.ts          startup
  config.ts         global settings
  slackApps.ts      one Slack connection per company workspace
  db.ts             SQLite task store
  companies.ts      companies.yaml: per-company Slack/Jira/git + repos, repo hints
  intake/slack.ts   mention capture + Go/Skip/repo buttons
  intake/jira.ts    Jira polling
  triage.ts         coding? which repo? plan?
  pipeline.ts       triage → DM card (→ auto-start)
  worker.ts         clone → branch → agent → push → PR
  agent.ts          Claude Agent SDK run + permission rules
  providers.ts      GitHub PR / GitLab MR
  notify.ts         Slack DM cards and thread updates
  git.ts            safe git exec + token redaction
```

## Next steps
1. **Update the PR from review comments:** poll the PR/MR for your review comments, then rerun the agent on the same branch.
2. **Post back to the source after you approve:** reply "PR is up" in the Slack thread and move the Jira ticket to In Review.
3. **Run tasks in parallel:** run each task in its own container with a concurrency limit.
4. **Team mode** (later): per-user settings and a central service.
5. **Per-company Anthropic keys:** to bill each client separately.
