import { selfTest } from "./claude.js";
import { companies } from "./companies.js";
import { config } from "./config.js";
import { startJiraPolling } from "./intake/jira.js";
import { registerSlackActions, registerSlackIntake } from "./intake/slack.js";
import { workspaces } from "./slackApps.js";
import { recoverQueue } from "./worker.js";

async function main(): Promise<void> {
  await selfTest();
  console.log(`[claude] CLI self-test passed (AUTH_MODE=${config.authMode})`);

  for (const ws of workspaces.values()) {
    registerSlackIntake(ws);
    registerSlackActions(ws);
    await ws.app.start();
    console.log(`[slack:${ws.companyId}] connected (Socket Mode)`);
  }

  startJiraPolling();
  recoverQueue();

  for (const c of companies) {
    console.log(
      `[company:${c.id}] ${c.repos.length} repos · slack ${c.slack ? "own" : `via ${c.notifyVia}`} · jira ${c.jira ? "on" : "off"}`,
    );
  }
  console.log(`[backendbot] ready · ${companies.length} companies · auto-start ${config.autoStart ? "ON" : "off"}`);

  for (const ws of workspaces.values()) {
    const served = companies.filter((c) => (c.slack ? c.id : c.notifyVia) === ws.companyId).map((c) => c.name);
    await ws.app.client.chat
      .postMessage({ channel: ws.myUserId, text: `🟢 BackendBot is online here for: ${served.join(", ")}.` })
      .catch((e) => console.error(`[slack:${ws.companyId}] could not DM ${ws.myUserId}: ${e.data?.error ?? e.message}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
