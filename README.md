# BackendBot

My personal coding agent. When I'm mentioned in Slack or assigned a Jira ticket, it works out
whether it's a coding task and which repo it belongs to, then DMs me a plan. When I tap **Go**, it
clones the repo into a fresh workspace, creates its own `agent/...` branch, writes the code and tests,
opens a **draft** PR (GitHub) or MR (GitLab), and DMs me the link.

```
Slack mention / Jira assignment
   → capture task (SQLite, deduped by thread / ticket key)
   → triage: coding? which repo? plan?
   → DM me: summary · plan · repo picker · [Go] [Skip]
   → on Go: fresh clone → agent/<branch> → Claude Agent SDK codes + runs tests → commit
   → push → draft PR/MR → DM me the link + what to check
```

## My setup at a glance

| | |
|---|---|
| Company | **CompanyA** (`id: companya`) |
| Slack workspace | CompanyA. My member ID: `U0123456789` |
| Jira | https://companya.atlassian.net (as `me@companya.com`), polled every 120s |
| Models | `claude-sonnet-5-5` for both triage and coding |
| Limits per task | 60 turns · $3 budget · 30 min timeout |
| Auto-start | **off**. Nothing runs until I tap Go |
| Commits authored as | `BackendBot <backendbot@users.noreply.github.com>` |

### Repos

| Name | Repo | Base branch | Token (`.env`) | Routed by |
|---|---|---|---|---|
| Dashboard | `companya/web-dashboard` (GitHub) | `dev` | `COMPANYA_GITHUB_TOKEN` | Slack `#dashboard` · ui, report, chart |
| Payments | `companya-payments/payments-api` (GitHub) | `main` | `COMPANYA_PAYMENTS_GITHUB_TOKEN` | Jira `PAY` · Slack `#payments` `#billing` · invoice, refund, checkout |

The two repos live in different GitHub orgs, and a fine-grained GitHub token only covers one org,
so Payments has its own token (`token_env` on that repo in `companies.yaml`).

### Where things live
- `.env`: all secrets (Anthropic key, Slack bot/app/user tokens, Jira token, GitHub/GitLab tokens). Never commit it.
- `companies.yaml`: companies, repos and routing hints. It only *names* the env vars that hold secrets.
- `data/`: the SQLite task DB (`backendbot.db`) and the per-task clones under `data/work/companya/`.

## Run it

```bash
docker compose up -d --build   # build and start (also after any change to src/ or Dockerfile)
docker compose logs -f         # watch it
docker compose restart         # after editing companies.yaml or .env
docker compose down            # stop
```

A healthy start looks like this, followed by a 🟢 DM in Slack:
```
[slack:companya] connected (Socket Mode)
[jira:companya] polling https://companya.atlassian.net every 120s
[company:companya] 2 repos · slack own · jira on
[backendbot] ready · 1 companies · auto-start off
```

## Day to day
- Every task gets one DM card. Progress, the PR link, test results, assumptions and questions go in its thread.
- **Wrong repo?** Change it in the dropdown before tapping Go.
- **Failed?** The reason is in the thread, and the workspace is kept under `data/work/companya/` for
  inspection. Tap **Go** to retry.
- To see recent tasks:
  ```bash
  sqlite3 data/backendbot.db "select company,id,status,repo,pr_url,cost_usd from tasks order by created_at desc limit 20"
  ```

## Troubleshooting

**No DMs at all, but the logs look fine.** Check `slack.my_user_id` in `companies.yaml`. It must be my
member ID in *that* workspace (e.g. `U0123456789`), not the example value. If it's wrong,
every DM fails with `channel_not_found` and the Go/Skip buttons ignore me. Startup now logs
`could not DM ...` when this happens. To look up the ID behind the user token:
```bash
docker compose exec -T backendbot node -e 'new (require("@slack/web-api").WebClient)(process.env.COMPANYA_SLACK_USER_TOKEN).auth.test().then(r=>console.log(r.user_id, r.team))'
```

**Mentions aren't picked up.** The app needs the user scopes and `user_events` from
`slack-app-manifest.yaml`. Reinstall the app after changing the manifest and update the `xoxp-` token in `.env`.

**Clone or push fails.** Check that the repo's token covers that org (e.g. `companya` vs `companya-payments`) and
has **Contents** and **Pull requests** set to read/write.

**Tests can't run in the container.** The image has Node 22, Python 3, make and g++. Add any other
toolchain a repo needs to the `Dockerfile`.

## Adding things

**A repo:** add an entry under `repos:` in `companies.yaml` with `name`, `provider`, `path`,
`default_branch`, `description` and routing hints (`jira_projects`, `slack_channels`, `keywords`).
If it's in a GitHub org not covered by the company's main GitHub token, create a fine-grained token for that
org, add it to `.env`, and set `token_env` on the repo. Then add a `CLAUDE.md` at the repo root
covering how to build, lint and test, the folder layout, the error-handling pattern, and one good
example endpoint and test. The agent reads it automatically.

**Another company** (a client I contract for):
1. Create a Slack app in their workspace from `slack-app-manifest.yaml`, install it, and copy the
   bot (`xoxb-`), user (`xoxp-`) and app-level (`xapp-`, `connections:write`) tokens. Get my member ID there.
   If they have no Slack, use `notify_via: companya` to send their cards to the CompanyA workspace instead.
2. Create a Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens with that company's login.
3. Create git tokens: GitHub fine-grained (one per org) or GitLab (`api` + `write_repository`, with `url` if self-hosted).
4. Add the secrets to `.env` and a new entry to `companies.yaml` (see `companies.example.yaml`).

> Before connecting a client, check that their policy or my contract allows sending their code and
> tickets to an AI provider.

Companies stay separate. Triage only sees that company's repos, cards go to its own Slack, each
clone and push uses its own token, Jira keys are tracked per company, and buttons only act on tasks
from their own workspace.

## Safety model
- **Ask-first.** Nothing is coded until I tap Go, and only my Slack user ID can press the buttons.
  `AUTO_START=true` lets confident tasks start on their own. Leave it off until triage has been reliable for a few weeks.
- **Request text is treated as data, not instructions,** in both the triage and agent prompts.
- **No secrets reach the agent.** Its environment is just `PATH`, `HOME` and the Anthropic key. The git
  remote has no token in it. Credentials only go to `git clone` and `git push`, which this program runs itself.
- **Blocked commands:** `git push`/`remote`, `curl`/`wget`/`ssh`, `docker`/`kubectl`/cloud CLIs, `sudo`, `rm -rf /`.
  Web tools are disabled.
- **Only `agent/*` branches and draft PRs.** It can't merge or deploy. Keep `dev`/`main` protected.
- **Only repos in `companies.yaml`.** Tasks run one at a time.

> The command blocklist is a guardrail, not a perfect sandbox. Run it in Docker, on a machine without
> production credentials, with tokens scoped only to the repos listed above.

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
1. **Update the PR from review comments:** poll the PR/MR for my review comments, then rerun the agent on the same branch.
2. **Post back to the source after I approve:** reply "PR is up" in the Slack thread and move the Jira ticket to In Review.
3. **Run tasks in parallel:** run each task in its own container with a concurrency limit.
4. **Per-company Anthropic keys:** to bill each client separately.
