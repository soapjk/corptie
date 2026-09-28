export function handlePlatformConfirmationHttpRequest({ request, response, url, platformConfirmationService, readJson, sendJson, errorStatus }) {
  if (request.method === "POST" && url.pathname === "/platform/confirmations") {
    readJson(request).then((input) => sendJson(response, 201, {
      confirmation: platformConfirmationService.issue({
        actorId: input.actorId, sessionId: input.sessionId, tool: input.tool, arguments: input.arguments ?? {}
      })
    })).catch((error) => sendJson(response, errorStatus(error, 403), { error: error.message, code: error.code ?? "PLATFORM_CONFIRMATION_FAILED" }));
    return true;
  }
  const platformConfirmationMatch = url.pathname.match(/^\/platform\/confirmations\/([^/]+)\/(confirm|reject)$/);
  if (request.method === "POST" && platformConfirmationMatch) {
    try {
      const confirmation = platformConfirmationService.resolve(
        decodeURIComponent(platformConfirmationMatch[1]),
        platformConfirmationMatch[2] === "confirm"
      );
      sendJson(response, 200, { confirmation });
    } catch (error) {
      sendJson(response, errorStatus(error, 409), { error: error.message, code: error.code ?? "PLATFORM_CONFIRMATION_FAILED" });
    }
    return true;
  }

  return false;
}
