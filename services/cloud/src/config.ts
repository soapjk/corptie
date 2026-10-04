import { z } from "zod";

const csv = z.string().transform((value, context) => {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one value" });
    return z.NEVER;
  }
  return values;
});

const environmentSchema = z.object({
  CORPTIE_CLOUD_HOST: z.string().default("127.0.0.1"),
  CORPTIE_CLOUD_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  CORPTIE_CLOUD_DATABASE_PATH: z.string().min(1),
  CORPTIE_CLOUD_PUBLIC_BASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  }, "must use HTTPS unless it targets loopback"),
  CORPTIE_CLOUD_AUTH_SECRET: z.string().min(32),
  CORPTIE_CLOUD_ADMIN_TOKEN: z.string().min(32),
  CORPTIE_CLOUD_PUBLIC_REGISTRATION: z.enum(["true", "false"]).default("true"),
  CORPTIE_CLOUD_TRUSTED_ORIGINS: csv,
  CORPTIE_CLOUD_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  CORPTIE_CLOUD_MAX_JSON_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  CORPTIE_CLOUD_RELAY_MAX_FRAME_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(262_144),
  CORPTIE_CLOUD_RELAY_MAX_QUEUED_BYTES: z.coerce.number().int().min(65_536).max(16_777_216).default(1_048_576),
  CORPTIE_CLOUD_RELAY_MAX_CONNECTIONS_PER_ACCOUNT: z.coerce.number().int().min(1).max(1_000).default(20),
  CORPTIE_CLOUD_RELAY_HEARTBEAT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  CORPTIE_CLOUD_VERSION: z.string().min(1).default("development"),
  CORPTIE_CLOUD_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORPTIE_CLOUD_MAIL_MODE: z.enum(["capture", "smtp"]).default("capture"),
  CORPTIE_CLOUD_SMTP_HOST: z.string().min(1).optional(),
  CORPTIE_CLOUD_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  CORPTIE_CLOUD_SMTP_SECURE: z.enum(["true", "false"]).optional(),
  CORPTIE_CLOUD_SMTP_USER: z.string().min(1).optional(),
  CORPTIE_CLOUD_SMTP_PASS: z.string().min(1).optional(),
  CORPTIE_CLOUD_SMTP_FROM: z.string().min(3).optional()
});

export type CloudMailConfig = { mode: "capture" } | {
  mode: "smtp";
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

export interface CloudConfig {
  host: string;
  port: number;
  databasePath: string;
  publicBaseUrl: string;
  authSecret: string;
  adminToken: string;
  publicRegistration: boolean;
  trustedOrigins: string[];
  logLevel: "error" | "warn" | "info" | "debug";
  maxJsonBytes: number;
  relayMaxFrameBytes: number;
  relayMaxQueuedBytes: number;
  relayMaxConnectionsPerAccount: number;
  relayHeartbeatMs: number;
  version: string;
  environment: "development" | "test" | "production";
  mail: CloudMailConfig;
}

export function loadCloudConfig(environment: NodeJS.ProcessEnv): CloudConfig {
  const parsed = environmentSchema.parse(environment);
  const publicUrl = new URL(parsed.CORPTIE_CLOUD_PUBLIC_BASE_URL);
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("CORPTIE_CLOUD_PUBLIC_BASE_URL must not include a path, query, or fragment");
  }
  if (parsed.CORPTIE_CLOUD_ENV === "production" && parsed.CORPTIE_CLOUD_MAIL_MODE !== "smtp") {
    throw new Error("Production requires CORPTIE_CLOUD_MAIL_MODE=smtp");
  }
  let mail: CloudMailConfig = { mode: "capture" };
  if (parsed.CORPTIE_CLOUD_MAIL_MODE === "smtp") {
    const required = {
      host: parsed.CORPTIE_CLOUD_SMTP_HOST,
      port: parsed.CORPTIE_CLOUD_SMTP_PORT,
      secure: parsed.CORPTIE_CLOUD_SMTP_SECURE,
      user: parsed.CORPTIE_CLOUD_SMTP_USER,
      password: parsed.CORPTIE_CLOUD_SMTP_PASS,
      from: parsed.CORPTIE_CLOUD_SMTP_FROM
    };
    if (!required.host || !required.port || !required.secure || !required.user || !required.password || !required.from) {
      throw new Error("SMTP mode requires host, port, secure, user, pass, and from settings");
    }
    mail = {
      mode: "smtp",
      host: required.host,
      port: required.port,
      secure: required.secure === "true",
      user: required.user,
      password: required.password,
      from: required.from
    };
  }

  return {
    host: parsed.CORPTIE_CLOUD_HOST,
    port: parsed.CORPTIE_CLOUD_PORT,
    databasePath: parsed.CORPTIE_CLOUD_DATABASE_PATH,
    publicBaseUrl: publicUrl.origin,
    authSecret: parsed.CORPTIE_CLOUD_AUTH_SECRET,
    adminToken: parsed.CORPTIE_CLOUD_ADMIN_TOKEN,
    publicRegistration: parsed.CORPTIE_CLOUD_PUBLIC_REGISTRATION === "true",
    trustedOrigins: parsed.CORPTIE_CLOUD_TRUSTED_ORIGINS,
    logLevel: parsed.CORPTIE_CLOUD_LOG_LEVEL,
    maxJsonBytes: parsed.CORPTIE_CLOUD_MAX_JSON_BYTES,
    relayMaxFrameBytes: parsed.CORPTIE_CLOUD_RELAY_MAX_FRAME_BYTES,
    relayMaxQueuedBytes: parsed.CORPTIE_CLOUD_RELAY_MAX_QUEUED_BYTES,
    relayMaxConnectionsPerAccount: parsed.CORPTIE_CLOUD_RELAY_MAX_CONNECTIONS_PER_ACCOUNT,
    relayHeartbeatMs: parsed.CORPTIE_CLOUD_RELAY_HEARTBEAT_MS,
    version: parsed.CORPTIE_CLOUD_VERSION,
    environment: parsed.CORPTIE_CLOUD_ENV,
    mail
  };
}
