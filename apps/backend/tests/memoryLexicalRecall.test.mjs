import assert from "node:assert/strict";
import test from "node:test";
import { HubService } from "../src/application/hubService.mjs";

const hub = new HubService({ store: {} });
const cat = { id: "cat", content: "用户养有一只公猫。", confidence: 0.99 };

test("generic words cannot recall an unrelated memory or contribute a keyword boost", async () => {
  for (const intent of ["用户", "当前这个用户需要相关信息", "the user please"]) {
    const [result] = await hub.scoreMemories(intent, [cat], { allowEmbedding: false });
    assert.equal(result.score, 0, intent);
  }
  const [plain] = await hub.scoreMemories("用户 公猫", [cat], { allowEmbedding: false });
  const [genericKeyword] = await hub.scoreMemories("用户 公猫",
    [{ ...cat, keywords_json: '["用户"]' }], { allowEmbedding: false });
  assert.ok(plain.score >= 0.18);
  assert.equal(genericKeyword.score, plain.score);
});

test("removing stopwords preserves word boundaries and technical identifiers", async () => {
  const [boundary] = await hub.scoreMemories("甲甲用户乙乙",
    [{ ...cat, content: "甲乙" }], { allowEmbedding: false });
  assert.equal(boundary.score, 0);
  const [technical] = await hub.scoreMemories("UserDefaults",
    [{ ...cat, content: "Use UserDefaults for local settings." }], { allowEmbedding: false });
  assert.ok(technical.score >= 0.18);
});
