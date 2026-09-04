import assert from "node:assert/strict";
import test from "node:test";
import {
  HostToolCatalog,
  TOOL_CATALOG_SEARCH,
  TOOL_DOMAIN_LOAD,
  TOOL_HOST_BOOTSTRAP_ABI_DEFINITIONS,
  TOOL_HOST_BOOTSTRAP_ABI_REVISION,
  TOOL_HOST_BOOTSTRAP_CONTRACT_HASH,
  TOOL_HOST_BOOTSTRAP_SCHEMA_HASH,
  TOOL_RESTRICTED_GATEWAY,
  computedToolHostBootstrapContractHash,
  computedToolHostBootstrapSchemaHash,
  schemaHash,
  toolDefinitionsContractHash
} from "../src/application/hostToolCatalog.mjs";

function namespace(id = "artifacts") {
  return {
    id,
    tools: [{
      name: `corptie_${id}_get`,
      description: `Read ${id}`,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }],
    execute: ({ arguments: args }) => args
  };
}

test("CatalogSnapshot hash is stable and public bootstrap contains only search/load", () => {
  const left = new HostToolCatalog([namespace("artifacts"), namespace("memory")]);
  const right = new HostToolCatalog([namespace("memory"), namespace("artifacts")]);
  assert.equal(left.snapshot().catalogVersion, right.snapshot().catalogVersion);
  assert.deepEqual(left.snapshot().bootstrap, [TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD]);
  assert.equal(left.snapshot().bootstrapAbiRevision, TOOL_HOST_BOOTSTRAP_ABI_REVISION);
  assert.equal(left.snapshot().bootstrapSchemaHash, TOOL_HOST_BOOTSTRAP_SCHEMA_HASH);
  assert.equal(computedToolHostBootstrapSchemaHash(), TOOL_HOST_BOOTSTRAP_SCHEMA_HASH);
  assert.equal(computedToolHostBootstrapContractHash(), TOOL_HOST_BOOTSTRAP_CONTRACT_HASH);
  assert.deepEqual(
    TOOL_HOST_BOOTSTRAP_ABI_DEFINITIONS.map((tool) => tool.name),
    [TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD, TOOL_RESTRICTED_GATEWAY]
  );
  assert.deepEqual(left.bootstrapDefinitions().map((tool) => tool.name), [TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD]);
  assert.equal(left.definitions().some((tool) => tool.name === TOOL_CATALOG_SEARCH), false);
  assert.equal(left.snapshot().domains.find((domain) => domain.domainId === "artifacts").canonicalToolNames.length, 1);
});

test("Tool descriptions change definition identity without changing the invocation contract", () => {
  const before = [{
    name: "corptie_example",
    description: "Old guidance",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    deferLoading: false
  }];
  const after = [{ ...before[0], description: "New guidance with a better example" }];
  assert.notEqual(schemaHash(before), schemaHash(after));
  assert.equal(toolDefinitionsContractHash(before), toolDefinitionsContractHash(after));

  const incompatible = [{
    ...after[0],
    inputSchema: { ...after[0].inputSchema, required: ["id", "revision"] }
  }];
  assert.notEqual(toolDefinitionsContractHash(before), toolDefinitionsContractHash(incompatible));

  const oldCatalog = new HostToolCatalog([{
    id: "example",
    tools: before,
    execute: () => null
  }]);
  const newCatalog = new HostToolCatalog([{
    id: "example",
    tools: after,
    execute: () => null
  }]);
  assert.notEqual(oldCatalog.snapshot().catalogVersion, newCatalog.snapshot().catalogVersion);
  assert.equal(oldCatalog.snapshot().catalogContractVersion, newCatalog.snapshot().catalogContractVersion);
});

test("Catalog keeps every capability namespace deferred and locks the bootstrap ABI", () => {
  const catalog = new HostToolCatalog([namespace("artifacts")]);
  assert.equal(catalog.entry("corptie_artifacts_get").exposure, "deferred");
  assert.throws(() => catalog.register({
    ...namespace("unsafe-namespace"),
    exposure: "bootstrap"
  }), { code: "TOOL_BOOTSTRAP_ABI_LOCKED" });
  assert.throws(() => catalog.register({
    ...namespace("unsafe-tool"),
    tools: [{ ...namespace("unsafe-tool").tools[0], exposure: "bootstrap" }]
  }), { code: "TOOL_BOOTSTRAP_ABI_LOCKED" });

  const before = catalog.snapshot();
  catalog.register(namespace("future-domain"));
  const after = catalog.snapshot();
  assert.notEqual(after.catalogVersion, before.catalogVersion);
  assert.equal(after.bootstrapSchemaHash, before.bootstrapSchemaHash);
  assert.deepEqual(after.bootstrap, before.bootstrap);
});

test("Catalog rejects canonical, alias, and Skill MCP source name conflicts", () => {
  assert.throws(() => new HostToolCatalog([namespace("artifacts"), namespace("artifacts")]), {
    code: "TOOL_CATALOG_NAME_CONFLICT"
  });
  assert.throws(() => new HostToolCatalog([namespace("memory"), {
    id: "skill",
    source: { kind: "skill_mcp", sourceId: "skill:one/server:one" },
    tools: [{ name: "skill_read", aliases: [{ name: "corptie_memory_get", deprecated: true }] }],
    execute: () => null
  }]), { code: "TOOL_CATALOG_NAME_CONFLICT" });
});

test("Catalog enforces strict schemas and executes with the canonical alias owner", async () => {
  const catalog = new HostToolCatalog([{
    ...namespace("artifacts"),
    tools: [{
      name: "corptie_artifact_get", aliases: ["corptie.artifact.get"],
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }]
  }]);
  await assert.rejects(() => catalog.execute({
    tool: "corptie_artifact_get", arguments: { id: "one", ignored: true }
  }), { code: "TOOL_ARGUMENT_SCHEMA_INVALID", path: "$.ignored" });
  assert.deepEqual(await catalog.execute({
    tool: "corptie.artifact.get", arguments: { id: "one" }
  }), { id: "one" });
});
