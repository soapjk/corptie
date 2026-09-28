import { formatFeishuFailureForLog } from "./feishuGatewayManager.mjs";

// The server applies readiness, maintenance and preview gates before dispatch.
export function handleFeishuHttpRequest({
  request, response, url, feishuGateway, store,
  readJson, sendJson, emitEvent, unifiedErrorStatus
}) {
  if (request.method === "GET" && url.pathname === "/feishu/status") {
    sendJson(response, 200, feishuGateway.status());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/feishu/profiles") {
    feishuGateway.listProfiles()
      .then((profiles) => sendJson(response, 200, { profiles }))
      .catch((error) => sendJson(response, 502, { error: error.message }));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/feishu/bots") {
    sendJson(response, 200, { bots: feishuGateway.listBots() });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/feishu/bots") {
    readJson(request)
      .then(async (input) => {
        try {
          return await feishuGateway.createBot(input);
        } catch (error) {
          const mode = typeof input.profile === "string" && input.profile.trim() ? "profile" : "credentials";
          const stage = typeof error.feishuStage === "string" ? error.feishuStage : "validation";
          console.error(
            `[feishu] create bot failed mode=${mode} stage=${stage} error=${formatFeishuFailureForLog(error, [input.appSecret])}`
          );
          throw error;
        }
      })
      .then((bot) => {
        emitEvent("FeishuBotCreated", { bot });
        sendJson(response, 201, { bot });
      })
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return true;
  }

  const feishuBotMatch = url.pathname.match(/^\/feishu\/bots\/([^/]+)$/);
  if (request.method === "PATCH" && feishuBotMatch) {
    const botId = decodeURIComponent(feishuBotMatch[1]);
    readJson(request)
      .then((input) => feishuGateway.updateBot(botId, input))
      .then((bot) => {
        if (!bot) {
          sendJson(response, 404, { error: "Feishu bot not found." });
          return;
        }
        emitEvent("FeishuBotUpdated", { bot });
        sendJson(response, 200, { bot });
      })
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return true;
  }

  if (request.method === "DELETE" && feishuBotMatch) {
    const botId = decodeURIComponent(feishuBotMatch[1]);
    feishuGateway.deleteBot(botId)
      .then((deleted) => {
        if (!deleted) {
          sendJson(response, 404, { error: "Feishu bot not found." });
          return;
        }
        emitEvent("FeishuBotDeleted", { botId });
        sendJson(response, 200, { deleted: true });
      })
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  const feishuPairingMatch = url.pathname.match(/^\/feishu\/bots\/([^/]+)\/pairing-code$/);
  if (request.method === "POST" && feishuPairingMatch) {
    const botId = decodeURIComponent(feishuPairingMatch[1]);
    readJson(request)
      .catch(() => ({}))
      .then((input) => feishuGateway.createPairingCode(botId, Number(input.ttlMs) || undefined))
      .then((pairing) => {
        if (!pairing) {
          sendJson(response, 404, { error: "Feishu bot not found." });
          return;
        }
        sendJson(response, 201, pairing);
      })
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return true;
  }

  const feishuAssignmentMatch = url.pathname.match(/^\/feishu\/bots\/([^/]+)\/assignment$/);
  if (request.method === "POST" && feishuAssignmentMatch) {
    const botId = decodeURIComponent(feishuAssignmentMatch[1]);
    readJson(request)
      .then(async (input) => {
        const binding = input.bindingId
          ? feishuGateway.getBot(botId)?.bindings.find((item) => item.id === input.bindingId)
          : feishuGateway.getBot(botId)?.bindings[0];
        if (!binding) {
          const error = new Error("This bot does not have a verified Feishu user.");
          error.code = "FEISHU_NOT_BOUND";
          throw error;
        }
        return feishuGateway.assignSession(botId, binding.id, String(input.sessionId || ""));
      })
      .then((assignment) => {
        emitEvent("FeishuSessionAssigned", { assignment }, { sessionId: assignment.sessionId });
        sendJson(response, 200, { assignment });
      })
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code,
        assignment: error.assignment
      }));
    return true;
  }

  if (request.method === "DELETE" && feishuAssignmentMatch) {
    const botId = decodeURIComponent(feishuAssignmentMatch[1]);
    const previous = store.getFeishuAssignmentForBot(botId);
    feishuGateway.releaseSession(botId);
    if (previous) {
      emitEvent("FeishuSessionReleased", { botId, sessionId: previous.sessionId }, { sessionId: previous.sessionId });
    }
    sendJson(response, 200, { released: Boolean(previous) });
    return true;
  }

  const feishuBindingMatch = url.pathname.match(/^\/feishu\/bindings\/([^/]+)$/);
  if (request.method === "DELETE" && feishuBindingMatch) {
    const bindingId = decodeURIComponent(feishuBindingMatch[1]);
    const binding = feishuGateway.listBots()
      .flatMap((bot) => bot.bindings)
      .find((item) => item.id === bindingId);
    if (!binding) {
      sendJson(response, 404, { error: "Feishu binding not found." });
      return true;
    }
    store.revokeFeishuBinding(bindingId);
    emitEvent("FeishuBindingRevoked", { bindingId, botId: binding.botId });
    sendJson(response, 200, { revoked: true });
    return true;
  }

  return false;
}
