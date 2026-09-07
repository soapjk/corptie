import { RemoteWorkspaceError } from "../runtime/sshWorkspaceTransport.mjs";

/** Configuration stays local; only an explicit /probe POST contacts the saved host. */
export async function handleSshWorkspaceHttpRequest({ request, response, url, connections, repository, probes }) {
  if (!url.pathname.startsWith("/ssh/")) return false;
  const send = (status, body) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  try {
    // Native clients send no Origin. Do not expose SSH account metadata to a
    // browser page or accept cross-origin configuration mutations.
    if (request.headers.origin) throw error("SSH_BROWSER_ORIGIN_FORBIDDEN", "SSH configuration is available only to the native local client.", 403);
    if (request.method === "GET" && url.pathname === "/ssh/connections") {
      send(200, { connections: repository.listConnections(), aliases: await connections.listAliases() });
      return true;
    }
    const observationMatch = /^\/ssh\/workspaces\/(workspace:[a-f0-9-]+)\/observation$/u.exec(url.pathname);
    if (request.method === "GET" && observationMatch) {
      if (!repository.location(observationMatch[1])) throw error("SSH_WORKSPACE_NOT_FOUND", "Remote Workspace was not found.", 404);
      send(200, { observation: repository.observation(observationMatch[1]) });
      return true;
    }
    if (request.method !== "POST") { send(404, { error: "SSH configuration route not found." }); return true; }
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
      throw error("SSH_CONTENT_TYPE_REQUIRED", "JSON content type is required.", 415);
    }
    const input = await readInput(request);
    const probeMatch = /^\/ssh\/workspaces\/(workspace:[a-f0-9-]+)\/probe$/u.exec(url.pathname);
    if (probeMatch) {
      fields(input, []);
      if (!probes) throw error("SSH_PROBE_UNAVAILABLE", "Repository inspection is unavailable.", 409);
      send(200, await probes.inspect(probeMatch[1]));
    } else if (url.pathname === "/ssh/connections/inspect") {
      fields(input, ["hostAlias"]);
      const inspection = await connections.inspectAlias(input.hostAlias);
      // Fingerprints identify public host keys; raw key blobs need not travel
      // through the UI or into a model's context.
      send(200, { ...inspection, keys: inspection.keys.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })) });
    } else if (url.pathname === "/ssh/connections") {
      fields(input, ["hostAlias", "label", "fingerprint"]);
      send(201, { connection: await connections.register(input) });
    } else if (url.pathname === "/ssh/workspaces") {
      fields(input, ["connectionId", "rootPath"]);
      send(201, { workspace: repository.registerWorkspace(input), repository: null, gitCapability: "unverified" });
    } else {
      send(404, { error: "SSH configuration route not found." });
    }
  } catch (failure) {
    const known = failure instanceof RemoteWorkspaceError;
    send(known ? failure.statusCode : 500, {
      code: known ? failure.code : "SSH_CONFIGURATION_FAILED",
      error: known ? failure.message : "SSH configuration operation failed."
    });
  }
  return true;
}

async function readInput(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw error("SSH_INPUT_LIMIT", "SSH configuration request is too large.", 413);
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* invalid below */ }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw error("SSH_INPUT_INVALID", "A JSON object is required.", 400);
  return input;
}

function fields(input, allowed) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw error("SSH_INPUT_INVALID", "Unexpected SSH configuration field.", 400);
}

function error(code, message, statusCode) {
  const result = new RemoteWorkspaceError(code, message);
  result.statusCode = statusCode;
  return result;
}
