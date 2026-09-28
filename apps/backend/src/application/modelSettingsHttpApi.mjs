export function handleFoundationModelUpdateHttpRequest({
  request, response, url, backendStoreReady, store, foundationModelSettings,
  agentProviderRegistry, backgroundAgentService, taskSummaryService, readJson, sendJson
}) {
  if (request.method === "PUT" && url.pathname === "/settings/foundation-model") {
    if (!backendStoreReady || store.migrationInProgress) {
      sendJson(response, 503, { error: "Backend is initializing or in maintenance mode.", retryable: true });
      return true;
    }
    readJson(request).then((input) => {
      if (input.mode === "provider") agentProviderRegistry.get(input.providerId);
      const value = foundationModelSettings.save(input);
      backgroundAgentService.cancelCapabilityOperations();
      for (const taskID of taskSummaryService.running.keys()) taskSummaryService.request(taskID);
      taskSummaryService.onProviderChanged();
      sendJson(response, 200, value);
    }).catch(() => sendJson(response, 400, { error: "模型设置无效，请检查 Provider、模型和 API 地址。" }));
    return true;
  }
  return false;
}

export function handleChoiceParserTestHttpRequest({
  request, response, url, store, configureChoiceParserRuntime,
  parseChoiceStageWithConfiguredParser, readJson, sendJson
}) {
  if (request.method === "POST" && url.pathname === "/settings/choice-parser/test") {
    readJson(request)
      .then(async (input) => {
        const choiceParser = {
          ...(store.settings().choiceParser ?? {}),
          ...(input?.choiceParser ?? {}),
          agentProxy: input?.agentProxy ?? store.settings().agentProxy
        };
        configureChoiceParserRuntime(choiceParser);
        const sample = [
          "The agent is waiting for your choice:",
          "",
          "1. Open the README and summarize it",
          "2. Run the test suite",
          "3. Cancel and wait for more instructions",
          "",
          "Please choose one option."
        ].join("\n");
        const startedAt = Date.now();
        const parsed = await parseChoiceStageWithConfiguredParser(sample, choiceParser, {
          id: "settings-test",
          provider: "settings"
        });
        const durationMs = Date.now() - startedAt;
        if (!parsed || !Array.isArray(parsed.options) || parsed.options.length < 2) {
          return {
            ok: false,
            error: "Parser did not return enough options for the sample choice prompt.",
            options: parsed?.options ?? [],
            durationMs
          };
        }
        return {
          ok: true,
          options: parsed.options,
          confidence: parsed.confidence ?? 0,
          source: parsed.source ?? choiceParser?.provider ?? "",
          durationMs
        };
      })
      .then((result) => {
        sendJson(response, result.ok ? 200 : 422, result);
      })
      .catch((error) => {
        sendJson(response, 400, { ok: false, error: error.message });
      });
    return true;
  }

  return false;
}
