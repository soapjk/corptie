import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexResetForecastMonitor,
  classifyCodexResetPost,
  latestForecastFromItems,
  parseRssItems
} from "../src/runtime/codexResetForecastMonitor.mjs";

const now = new Date("2026-08-11T02:00:00.000Z");

test("parses a future Codex limit reset without inventing an exact timestamp", () => {
  const result = classifyCodexResetPost({
    id: "future-1",
    link: "https://x.com/thsottiaux/status/1",
    publishedAt: "2026-08-11T01:00:00.000Z",
    text: "Codex keeps growing. We will reset the usage limits again in a few hours."
  }, now);

  assert.equal(result.kind, "future");
  assert.equal(result.forecast.estimateLabel, "预计未来几小时内");
  assert.equal(result.forecast.postId, "future-1");
});

test("ignores completed resets and unrelated Codex posts", () => {
  assert.equal(classifyCodexResetPost({
    text: "Usage limits have now been reset for all paid users of Codex."
  }, now).kind, "completed");
  assert.equal(classifyCodexResetPost({
    text: "Codex shipped a new feature today."
  }, now).kind, "irrelevant");
});

test("a newer completion clears an older future forecast", () => {
  const forecast = latestForecastFromItems([{
    id: "planned",
    publishedAt: "2026-08-11T00:00:00.000Z",
    text: "We will reset Codex rate limits in a few hours."
  }, {
    id: "done",
    publishedAt: "2026-08-11T01:00:00.000Z",
    text: "Codex usage limits have now been reset."
  }], now);
  assert.equal(forecast, null);
});

test("parses Nitter RSS items and decodes entities", () => {
  const items = parseRssItems(`<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[Codex &amp; ChatGPT Work limits will reset in the next hour]]></title>
    <link>https://nitter.net/thsottiaux/status/123#m</link>
    <guid>https://nitter.net/thsottiaux/status/123#m</guid>
    <pubDate>Tue, 11 Aug 2026 01:00:00 GMT</pubDate>
  </item></channel></rss>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "https://nitter.net/thsottiaux/status/123#m");
  assert.match(items[0].text, /Codex & ChatGPT/);
});

test("monitor retains persisted forecast when the feed request fails", async () => {
  const saved = {
    forecast: {
      postId: "persisted",
      text: "We will reset Codex limits tomorrow.",
      url: null,
      publishedAt: "2026-08-11T00:00:00.000Z",
      estimateLabel: "预计明天",
      expiresAt: "2026-08-13T00:00:00.000Z"
    },
    checkedAt: "2026-08-11T00:00:00.000Z",
    sourceHealthy: true,
    sourceError: null
  };
  const writes = [];
  const monitor = new CodexResetForecastMonitor({
    store: {
      getRuntimeState: () => saved,
      setRuntimeState: (_key, value) => writes.push(value)
    },
    fetch: async () => { throw new Error("offline"); },
    now: () => now
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.forecast.postId, "persisted");
  assert.equal(snapshot.sourceHealthy, false);
  assert.equal(writes.length, 1);
});
