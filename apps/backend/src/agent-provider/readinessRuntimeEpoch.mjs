import { randomUUID } from "node:crypto";

// Local adapter proof only; no Provider I/O and no Provider-name branching.
export function createReadinessRuntimeEpoch(readRuntime) {
  const instance = randomUUID();
  const objects = new WeakMap();
  let sequence = 0;
  return reference => {
    const { object, state } = readRuntime(reference);
    let generation = 0;
    if (object && ["object", "function"].includes(typeof object)) {
      if (!objects.has(object)) objects.set(object, ++sequence);
      generation = objects.get(object);
    }
    return `${instance}:${generation}:${String(state ?? "unknown")}`;
  };
}
