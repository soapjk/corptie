import { performance } from "node:perf_hooks";
import { HubService } from "../src/application/hubService.mjs";

const embeddingLatencyMs = 30;
const iterations = 7;

const delayEmbedding = async () => {
  await new Promise((resolve) => setTimeout(resolve, embeddingLatencyMs));
  return [1, 0];
};

const memories = [
  { id: "memory:1", content: "first planning memory", confidence: 0.8, promotion_status: "active", revoked_at: null },
  { id: "memory:2", content: "second planning memory", confidence: 0.7, promotion_status: "active", revoked_at: null }
];

function storeFor(memoryCount) {
  return {
    listMemoriesByOwner: () => memories.slice(0, memoryCount),
    getMemoryEmbedding: () => null,
    setMemoryEmbedding: () => {},
    touchMemory: () => {},
    getMemory: () => null
  };
}

async function legacyContext(memoryCount) {
  await delayEmbedding();
  for (let index = 0; index < memoryCount; index += 1) await delayEmbedding();
}

async function optimizedContext(memoryCount) {
  const hub = new HubService({ store: storeFor(memoryCount), embedder: delayEmbedding });
  await hub.retrieveMemory("draft a plan", { agentId: "agent:benchmark" }, { touch: false });
}

async function measure(operation) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)];
}

for (const memoryCount of [0, 2]) {
  const legacyMedianMs = await measure(() => legacyContext(memoryCount));
  const optimizedMedianMs = await measure(() => optimizedContext(memoryCount));
  const savedMs = legacyMedianMs - optimizedMedianMs;
  console.log(JSON.stringify({
    memoryCount,
    embeddingLatencyMs,
    iterations,
    legacyMedianMs: rounded(legacyMedianMs),
    optimizedMedianMs: rounded(optimizedMedianMs),
    savedMs: rounded(savedMs),
    reductionPercent: rounded(savedMs / legacyMedianMs * 100)
  }));
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}
