#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import {
  initialTimelineSnapshot,
  nextTimelineEvent
} from "../apps/backend/src/utils/sessionTimelineDelta.mjs";

const baseUrl = process.env.CORPTIE_BENCHMARK_BACKEND_URL ?? "http://127.0.0.1:47321";
const iterations = Number(process.env.CORPTIE_DELTA_BENCHMARK_ITERATIONS ?? 100);
const sessionList = await fetchJson(`${baseUrl}/sessions`);
const candidates = [];
for (const session of sessionList.sessions ?? []) {
  try {
    const snapshot = await fetchJson(`${baseUrl}/sessions/${encodeURIComponent(session.id)}/snapshot`);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    candidates.push({ summary: session, snapshot, bytes });
  } catch {
    // A provider session may disappear while the read-only benchmark is enumerating it.
  }
}

const largest = candidates.sort((left, right) => right.bytes - left.bytes)[0];
if (!largest) throw new Error(`No readable sessions at ${baseUrl}`);
const session = largest.snapshot.session;
if (!Array.isArray(session.items) || session.items.length === 0) {
  throw new Error(`Largest session ${largest.summary.id} has no timeline items`);
}

const fastSamples = [];
const exactSamples = [];
let deltaBytes = 0;
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const initial = initialTimelineSnapshot(session);
  const updated = structuredClone(session);
  const tailIndex = updated.items.length - 1;
  updated.items[tailIndex].text = `${updated.items[tailIndex].text ?? ""}\nbenchmark-stream-${iteration}`;
  updated.updatedAt = new Date(Date.parse(session.updatedAt) + iteration + 1).toISOString();
  let startedAt = performance.now();
  const result = nextTimelineEvent(initial.state, updated, { fullConsistency: false });
  fastSamples.push(performance.now() - startedAt);
  if (result.event?.name !== "item.updated") {
    throw new Error(`Expected item.updated, received ${result.event?.name ?? "none"}`);
  }
  deltaBytes = Buffer.byteLength(JSON.stringify(result.event.data));
  startedAt = performance.now();
  nextTimelineEvent(initial.state, updated, { fullConsistency: true });
  exactSamples.push(performance.now() - startedAt);
}

fastSamples.sort((left, right) => left - right);
exactSamples.sort((left, right) => left - right);
const percentile = (samples, fraction) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * fraction))];
const ratio = largest.bytes / deltaBytes;
const report = [
  `backend=${baseUrl}`,
  `session=${largest.summary.title ?? largest.summary.id}`,
  `provider=${largest.summary.external?.provider ?? "unknown"}`,
  `items=${session.items.length}`,
  `snapshotBytes=${largest.bytes}`,
  `deltaBytes=${deltaBytes}`,
  `payloadReduction=${ratio.toFixed(2)}x`,
  `activeGenerationP50Ms=${percentile(fastSamples, 0.50).toFixed(3)}`,
  `activeGenerationP95Ms=${percentile(fastSamples, 0.95).toFixed(3)}`,
  `consistencyGenerationP50Ms=${percentile(exactSamples, 0.50).toFixed(3)}`,
  `consistencyGenerationP95Ms=${percentile(exactSamples, 0.95).toFixed(3)}`,
  `iterations=${iterations}`
].join("\n");
console.log(report);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}
