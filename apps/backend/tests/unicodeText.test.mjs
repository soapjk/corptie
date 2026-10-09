import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { boundedUnicodeText, clientSafeJSONStringify } from "../src/utils/unicodeText.mjs";
import { toolExecutionForItem, publicToolExecution } from "../src/utils/toolExecutionProjection.mjs";
import { sendJson } from "../src/application/backendHttpIO.mjs";
import { reply } from "../src/application/clientDeviceGateway.mjs";

test("bounded previews preserve graphemes and normalize old broken UTF-16", () => {
  for (const symbol of ["😀", "🇦🇺", "👩🏽‍💻", "e\u0301"]) {
    const text = "a".repeat(1996) + symbol + "more";
    const result = toolExecutionForItem({ type: "commandExecution", id: "tool", title: "run" }, { result: text }).result;
    assert.equal(result.isWellFormed(), true);
    assert.ok(result.length <= 2000);
    assert.equal(result, (symbol.length <= 3 ? text.slice(0, 1999) : "a".repeat(1996)) + "…");
  }
  assert.equal(boundedUnicodeText("x\ud83c…", 2000), "x�…");
  const old = { schemaVersion: 1, toolId: "tool", name: "run", status: "completed", result: "x\ud83c…" };
  assert.equal(publicToolExecution(old).result, "x�…");
});

test("desktop and device HTTP repair nested historical values without mutating input", () => {
  const payload = { session: { items: [{ toolExecution: { result: "\ud83c" } }] } };
  for (const send of [sendJson, reply]) {
    let output;
    send({ writeHead() {}, end(value) { output = value; } }, 200, payload);
    assert.equal(JSON.parse(output).session.items[0].toolExecution.result, "�");
  }
  assert.equal(payload.session.items[0].toolExecution.result, "\ud83c");
});

test("Apple JSONDecoder accepts the actual serialized regression shape", { skip: process.platform !== "darwin" }, () => {
  const payload = clientSafeJSONStringify({ items: [{ result: "a".repeat(1998) + "\ud83c…" }] });
  const result = spawnSync("swift", ["-e", `import Foundation
    struct Item: Decodable { let result: String }; struct Root: Decodable { let items: [Item] }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let root = try JSONDecoder().decode(Root.self, from: data)
    print(root.items.count)`], { input: payload, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1");
});
