import { sessionSchemaSql } from "./sessionSchemaSql.mjs";
import { feishuSchemaSql } from "./feishuSchemaSql.mjs";
import { registrySchemaSql } from "./registrySchemaSql.mjs";
import { collaborationSchemaSql } from "./collaborationSchemaSql.mjs";
import { executionQueueSchemaSql } from "./executionQueueSchemaSql.mjs";
import { workspaceSchemaSql } from "./workspaceSchemaSql.mjs";
import { workTaskSchemaSql } from "./workTaskSchemaSql.mjs";
import { artifactSchemaSql } from "./artifactSchemaSql.mjs";
import { integrationSchemaSql } from "./integrationSchemaSql.mjs";

// Preserve each original db.run batch, including statement order and whitespace.
export const sessionRuntimeSchemaSql = [
  sessionSchemaSql,
  feishuSchemaSql,
  registrySchemaSql,
  collaborationSchemaSql,
  executionQueueSchemaSql,
  workspaceSchemaSql
].join("");

export const workDomainSchemaSql = [
  workTaskSchemaSql,
  artifactSchemaSql,
  integrationSchemaSql
].join("");
