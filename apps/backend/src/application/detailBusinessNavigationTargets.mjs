const token = value => typeof value === "string" && /^[\x20-\x7e]{1,512}$/.test(value);
const types = Object.freeze({ references: ["contextReference", "reference"], artifacts: ["artifact", "artifact"],
  memories: ["memory", "memory"], schedules: ["automation", "schedule"] });

/** Resolve a normalized read-port row, not an arbitrary client target/URL.
 * This returns only a candidate: the host must still authorize and register
 * the exact platform destination before publishing an available action. */
export function detailBusinessNavigationTarget(moduleName, row) {
  const resource = row?.resource;
  if (!resource || !token(resource.id) || !token(resource.resourceType)) return null;
  if (moduleName === "focusTasks") {
    const target = row.sessionTarget;
    // A Task is a resource, never a Session receiver. A stale/missing binding
    // must not fall back to the current Session or Task ID.
    if (resource.resourceType !== "task" || target?.resourceType !== "session" || !token(target.id)) return null;
    return { resourceType: "session", id: target.id };
  }
  const mapping = Object.hasOwn(types, moduleName) ? types[moduleName] : null;
  if (!mapping || mapping[0] !== resource.resourceType) return null;
  return { resourceType: mapping[1], id: resource.id };
}
