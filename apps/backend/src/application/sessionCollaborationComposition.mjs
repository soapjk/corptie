import { SessionCollaborationService } from "./sessionCollaborationService.mjs";

// Server creates collaboration before startup composition is available. Resolve
// both operations at call time; never capture the initially-null service or
// replace its synchronous, authoritative binding proof with a synthetic one.
export function createSessionCollaborationComposition({ getWorkSessionStartApplicationService, ...options }) {
  if (typeof getWorkSessionStartApplicationService !== "function") {
    throw new TypeError("Session collaboration requires a startup service getter.");
  }
  const resolve = (method) => {
    const service = getWorkSessionStartApplicationService();
    if (typeof service?.[method] !== "function") {
      throw Object.assign(new Error("Verified Session startup capability is unavailable."), {
        code: method === "getSessionBinding" ? "START_REFERENCE_INVALID" : "CAPABILITY_UNAVAILABLE",
        statusCode: 503
      });
    }
    return service;
  };
  return new SessionCollaborationService({
    ...options,
    workSessionStartApplicationService: {
      start: (command) => resolve("start").start(command),
      getSessionBinding: (logicalSessionId) => resolve("getSessionBinding").getSessionBinding(logicalSessionId)
    }
  });
}
