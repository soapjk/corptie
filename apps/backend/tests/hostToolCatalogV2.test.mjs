import assert from "node:assert/strict";
import test from "node:test";
import {
  HostToolCatalog,
  TOOL_CATALOG_SEARCH,
  TOOL_DOMAIN_LOAD
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
  assert.deepEqual(left.bootstrapDefinitions().map((tool) => tool.name), [TOOL_CATALOG_SEARCH, TOOL_DOMAIN_LOAD]);
  assert.equal(left.definitions().some((tool) => tool.name === TOOL_CATALOG_SEARCH), false);
  assert.equal(left.snapshot().domains.find((domain) => domain.domainId === "artifacts").canonicalToolNames.length, 1);
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
