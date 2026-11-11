import { randomUUID } from "node:crypto";
import { logError } from "../utils/errorDiagnostics.mjs";
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
  request, response, url, agentProviderRegistry, firstRunSetup, readJson, sendJson, errorStatus, store
}) {
  const accountsMatch = url.pathname.match(/^\/providers\/([^/]+)\/accounts$/);
  if (accountsMatch && ["GET", "POST"].includes(request.method)) {
    const requestId = randomUUID();
    let stage = "list";
    Promise.resolve().then(async () => {
      const input = request.method === "POST" ? await readJson(request) : null;
      if (input && ["discover", "import", "select", "login", "delete", "rename", "cancel"].includes(input.action)) stage = input.action;
      return firstRunSetup.accountOperation(decodeURIComponent(accountsMatch[1]), input);
    })
      .then(result => sendJson(response, 200, result))
      .catch(error => {
        logError("provider-setup.accounts", error, { requestId, operation: "accountOperation", stage, method: request.method });
        sendJson(response, error.statusCode ?? 400, {
          error: error.code && !error.statusCode ? "无法完成账号操作，请检查本地运行目录和权限。" : error.message,
          code: error.code ?? null, requestId
        });
      });
    return true;
  }

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
    const requestId = randomUUID();
    firstRunSetup.status().then((result) => sendJson(response, 200, result))
      .catch((error) => firstRunFailure(error, request, response, url.pathname, requestId, sendJson));
    return true;
  }
  if (request.method === "POST" && ["/first-run/settings", "/first-run/provider", "/first-run/credentials", "/first-run/program", "/first-run/check", "/first-run/check/cancel", "/first-run/programs", "/first-run/authentication", "/first-run/assistant", "/first-run/complete", "/first-run/check-and-complete"].includes(url.pathname)) {
    const requestId = randomUUID();
    readJson(request).then(async (input) => {
      if (url.pathname === "/first-run/check-and-complete") return firstRunSetup.checkAndComplete(input);
      if (url.pathname === "/first-run/settings") return firstRunSetup.saveSettings(input);
      if (url.pathname === "/first-run/program") return firstRunSetup.setProgram(input);
      if (url.pathname === "/first-run/credentials") return firstRunSetup.saveCredentialSource(input);
      if (url.pathname === "/first-run/programs") return firstRunSetup.scanPrograms(input);
      if (url.pathname === "/first-run/check/cancel") return firstRunSetup.cancelCheck(input);
      if (url.pathname === "/first-run/check") return firstRunSetup.check(input);
      if (url.pathname === "/first-run/authentication") return firstRunSetup.authentication(input);
      if (url.pathname === "/first-run/provider") return firstRunSetup.setEnabled(input);
      return url.pathname === "/first-run/assistant" ? firstRunSetup.prepareAssistant() : firstRunSetup.complete(input);
    }).then((result) => sendJson(response, 200, result))
      .catch((error) => firstRunFailure(error, request, response, url.pathname, requestId, sendJson));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/providers") {
    sendJson(response, 200, {
      defaultProviderId: store?.settings?.().newSessionDefaults?.taskCreation?.providerId ?? agentProviderRegistry.defaultProviderId,
      providers: agentProviderRegistry.descriptors()
    });
    return true;
  }

  return false;
}


function firstRunFailure(error, request, response, operation, requestId, sendJson) {
  logError("first-run.http", error, { operation, requestId, method: request.method, stage: "request" });
  sendJson(response, 400, { error: error.message, requestId });
}
