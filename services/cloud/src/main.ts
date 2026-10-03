import { createCloudApplication } from "./application.js";
import { createCloudAuth } from "./auth.js";
import { loadCloudConfig } from "./config.js";
import { openCloudDatabase } from "./database.js";
import { CloudMailer } from "./mail.js";
import { AccountRevocationEvents } from "./accountSecurity.js";

const config = loadCloudConfig(process.env);
const database = openCloudDatabase(config.databasePath);
const mailer = new CloudMailer(config.mail, database);
const revocations = new AccountRevocationEvents();
const { auth, resolvePrincipal, provisionInvitedUser, verifyOAuthPageQuery } = createCloudAuth(config, database, { mailer, revocations });
const application = createCloudApplication({
  config, database, auth, resolvePrincipal, provisionInvitedUser, verifyOAuthPageQuery, revocations
});

const address = await application.listen();
console.info(JSON.stringify({
  event: "corptie_cloud_started",
  host: address.address,
  port: address.port,
  version: config.version
}));

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ event: "corptie_cloud_stopping", signal }));
  await application.close();
  await mailer.close();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
