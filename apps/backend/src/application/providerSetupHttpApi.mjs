import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";

export function handleProviderModelsHttpRequest({ request, response, url, sessionApplicationService, sendJson, unifiedErrorStatus }) {
  const providerModelsMatch = url.pathname.match(/^\/providers\/([^/]+)\/models$/);
  if (request.method === "GET" && providerModelsMatch) {
    const providerId = decodeURIComponent(providerModelsMatch[1]);
    // listModels 在 provider 不存在时会同步抛 AgentProviderNotFoundError；
    // 用 Promise.resolve().then() 包裹，把同步异常转为 rejection，交给 .catch 统一处理，
    // 避免未捕获异常导致进程崩溃（例如前端仍引用已删除的 codex-pty provider）。
    Promise.resolve()
      .then(() => sessionApplicationService.listModels(providerId, {
        refresh: url.searchParams.get("refresh") === "true"
      }))
      .then((models) => sendJson(response, 200, models))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  return false;
}

export function handleProviderSetupHttpRequest({
  request, response, url, agentProviderRegistry, firstRunSetup, readJson, sendJson, errorStatus
}) {
  const providerConfigurationActionMatch = url.pathname.match(
    /^\/providers\/([^/]+)\/(configuration\/validate|connection-test)$/
  );
  if (request.method === "POST" && providerConfigurationActionMatch) {
    const providerId = decodeURIComponent(providerConfigurationActionMatch[1]);
    const action = providerConfigurationActionMatch[2];
    readJson(request)
      .then((input) => agentProviderRegistry.invoke(
        providerId,
        action === "configuration/validate"
          ? AGENT_PROVIDER_CAPABILITIES.CONFIGURATION_VALIDATE
          : AGENT_PROVIDER_CAPABILITIES.CONNECTION_TEST,
        input
      ))
      .then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, errorStatus(error, error.statusCode ?? 400), {
        ok: false,
        error: error.message,
        code: error.code ?? "PROVIDER_CONFIGURATION_FAILED",
        retryable: error.retryable === true,
        ...(Array.isArray(error.details) ? { details: error.details } : {})
      }));
    return true;
  }

  if (url.pathname === "/first-run" && request.method === "GET") {
    firstRunSetup.status().then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return true;
  }
  if (request.method === "POST" && ["/first-run/provider", "/first-run/check", "/first-run/assistant", "/first-run/complete"].includes(url.pathname)) {
    readJson(request).then(async (input) => {
      if (url.pathname === "/first-run/check") return firstRunSetup.check(input);
      if (url.pathname === "/first-run/provider") return firstRunSetup.setEnabled(input);
      return url.pathname === "/first-run/assistant" ? firstRunSetup.prepareAssistant() : firstRunSetup.complete(input);
    }).then((result) => sendJson(response, 200, result))
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/providers") {
    sendJson(response, 200, {
      defaultProviderId: agentProviderRegistry.defaultProviderId,
      providers: agentProviderRegistry.descriptors()
    });
    return true;
  }

  return false;
}
