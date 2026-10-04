import { DatabaseSync } from "node:sqlite";
import { createCloudAuth } from "../src/auth.js";
import type { CloudConfig } from "../src/config.js";

const generationConfig: CloudConfig = {
  host: "127.0.0.1",
  port: 4310,
  databasePath: ":memory:",
  publicBaseUrl: "http://127.0.0.1:4310",
  authSecret: "schema-generation-only-secret-value",
  adminToken: "schema-generation-only-admin-token",
  publicRegistration: true,
  trustedOrigins: ["http://127.0.0.1:4310"],
  logLevel: "error",
  maxJsonBytes: 65_536,
  relayMaxFrameBytes: 262_144,
  relayMaxQueuedBytes: 1_048_576,
  relayMaxConnectionsPerAccount: 20,
  relayHeartbeatMs: 30_000,
  version: "schema-generation",
  environment: "development",
  mail: { mode: "capture" }
};

const database = new DatabaseSync(":memory:");
export const auth = createCloudAuth(generationConfig, database).auth;
