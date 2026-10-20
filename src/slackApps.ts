import bolt from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { companies, getCompany } from "./companies.js";

/** One connected Slack workspace (one per company that has Slack). */
export interface Workspace {
  companyId: string;
  app: bolt.App;          // bot: DMs you, receives button clicks
  user: WebClient;        // your user token: read-only use, fetches threads you're mentioned in
  myUserId: string;
}

export const workspaces = new Map<string, Workspace>();
for (const c of companies) {
  if (!c.slack) continue;
  workspaces.set(c.id, {
    companyId: c.id,
    app: new bolt.App({ token: c.slack.botToken, appToken: c.slack.appToken, socketMode: true }),
    user: new WebClient(c.slack.userToken),
    myUserId: c.slack.myUserId,
  });
}

/** Where a company's cards are posted: its own Slack, or the notify_via company's. */
export function notifyWorkspace(companyId: string): Workspace | undefined {
  const c = getCompany(companyId);
  if (!c) return undefined;
  return workspaces.get(c.slack ? c.id : c.notifyVia!);
}
