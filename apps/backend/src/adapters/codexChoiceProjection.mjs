import { choiceParserShouldUseModel, parseChoiceStageWithConfiguredParser } from "./choiceParser.mjs";
import { choiceParserBackoffKey, choiceParserRetryDelayMs } from "../utils/choiceParserBackoff.mjs";

// Codex-specific legacy projection adapter. The provider-neutral parser remains
// separate; this owner controls pending work, cache eviction and generation checks.
export function createCodexChoiceProjection({
  store, developmentPreview, upsertManagedCodexSession, emitEvent, now,
  parseChoices = parseChoiceStageWithConfiguredParser,
  shouldUseModel = choiceParserShouldUseModel
}) {
  const codexChoiceOptionsCache = new Map();
  const pendingCodexChoiceParses = new Set();
  const codexChoiceParseRetryAfter = new Map();
  const choiceGenerations = new Map();

  function currentChoiceGeneration(sessionId) {
    return choiceGenerations.get(sessionId) ?? 0;
  }

  function sessionIdForProviderThread(threadId) {
    return store.getLogicalSessionByProviderThreadId(threadId)?.legacySessionId
      ?? `codex:${threadId}`;
  }

  function bumpChoiceGeneration(sessionId) {
    const next = currentChoiceGeneration(sessionId) + 1;
    choiceGenerations.set(sessionId, next);
    return next;
  }


  function scheduleCodexChoiceParse(threadId, text, choiceParser, cacheKey, generation = currentChoiceGeneration(sessionIdForProviderThread(threadId))) {
    if (developmentPreview) return;
    const parserBackoffKey = choiceParserBackoffKey(choiceParser);
    const retryAfter = Math.max(
      codexChoiceParseRetryAfter.get(cacheKey) ?? 0,
      codexChoiceParseRetryAfter.get(parserBackoffKey) ?? 0
    );
    if (retryAfter > Date.now()) {
      return;
    }
    if (pendingCodexChoiceParses.has(cacheKey)) {
      return;
    }
    pendingCodexChoiceParses.add(cacheKey);
    const scheduledAt = Date.now();
    console.log(`[choice-parser] event=codex-app-server-scheduled session=codex:${threadId} ${JSON.stringify({ at: new Date(scheduledAt).toISOString(), chars: String(text).length })}`);
    parseChoices(text, choiceParser, {
      id: `codex:${threadId}`,
      provider: "codex-app-server"
    })
      .then((parsed) => {
        codexChoiceParseRetryAfter.delete(cacheKey);
        codexChoiceParseRetryAfter.delete(parserBackoffKey);
        if (!parsed || !Array.isArray(parsed.options) || parsed.options.length < 2 || parsed.confidence < 0.45) {
          return;
        }
        const options = parsed.options.slice(0, 6).map((option, index) => ({
          id: option.id || `${option.role ?? "option"}-${index}`,
          label: option.label,
          role: option.role ?? "message-choice",
          index,
          selected: index === parsed.selectedIndex
        }));
        codexChoiceOptionsCache.set(cacheKey, options.map((option) => ({ ...option })));
        if (codexChoiceOptionsCache.size > 200) {
          codexChoiceOptionsCache.delete(codexChoiceOptionsCache.keys().next().value);
        }
        applyCodexChoiceOptionsToManagedSession(threadId, text, options, generation);
        console.log(`[choice-parser] event=codex-app-server-detail-accepted session=codex:${threadId} ${JSON.stringify({ at: new Date().toISOString(), queuedMs: Date.now() - scheduledAt, options: options.length, confidence: parsed.confidence, source: parsed.source, async: true })}`);
        emitEvent("CodexThreadChoiceOptionsUpdated", { threadId, optionsCount: options.length });
      })
      .catch((error) => {
        const retryDelayMs = choiceParserRetryDelayMs(error);
        const retryAt = Date.now() + retryDelayMs;
        codexChoiceParseRetryAfter.set(cacheKey, retryAt);
        codexChoiceParseRetryAfter.set(parserBackoffKey, retryAt);
        console.log(`[choice-parser] event=codex-app-server-detail-error session=codex:${threadId} ${JSON.stringify({ error: error.message, retryDelayMs, retryAt: new Date(retryAt).toISOString(), async: true })}`);
      })
      .finally(() => {
        pendingCodexChoiceParses.delete(cacheKey);
      });
  }

  function choiceOptionsCacheKey(text = "", choiceParser = {}) {
    const normalized = String(text).replace(/\s+/g, " ").trim();
    return JSON.stringify({
      provider: choiceParser.provider ?? "",
      model: choiceParser.provider === "openai" ? choiceParser.openaiModel : choiceParser.localModel,
      text: normalized.slice(-4000)
    });
  }

  function scheduleCodexChoiceParseForText(threadId, text) {
    const cleanText = typeof text === "string" ? text.trim() : "";
    if (!cleanText) {
      return;
    }
    if (!shouldUseModel(cleanText)) {
      return;
    }
    const settings = store.settings();
    const choiceParser = {
      ...(settings.choiceParser ?? {}),
      agentProxy: settings.agentProxy
    };
    if (!choiceParser.provider || choiceParser.provider === "disabled") {
      return;
    }
    const cacheKey = choiceOptionsCacheKey(cleanText, choiceParser);
    const generation = currentChoiceGeneration(sessionIdForProviderThread(threadId));
    if (codexChoiceOptionsCache.has(cacheKey)) {
      applyCodexChoiceOptionsToManagedSession(threadId, cleanText, codexChoiceOptionsCache.get(cacheKey), generation);
      return;
    }
    scheduleCodexChoiceParse(threadId, cleanText, choiceParser, cacheKey, generation);
  }

  function applyCodexChoiceOptionsToManagedSession(threadId, text, options, generation = currentChoiceGeneration(sessionIdForProviderThread(threadId))) {
    const sessionId = sessionIdForProviderThread(threadId);
    const session = store.getSession(sessionId);
    if (!session) {
      return null;
    }
    if (generation !== currentChoiceGeneration(sessionId) || session.status === "running") {
      console.log(`[choice-parser] event=codex-app-server-options-stale-generation session=${sessionId} ${JSON.stringify({ at: new Date().toISOString(), generation, currentGeneration: currentChoiceGeneration(sessionId), status: session.status })}`);
      return null;
    }
    const normalizedSessionSummary = String(session.summary ?? "").replace(/\s+/g, " ").trim();
    const normalizedText = String(text ?? "").replace(/\s+/g, " ").trim();
    const summaryMatches = !normalizedSessionSummary
      || normalizedSessionSummary === normalizedText
      || normalizedSessionSummary.includes(normalizedText.slice(0, 120))
      || normalizedText.includes(normalizedSessionSummary.slice(0, 120));
    if (!summaryMatches) {
      console.log(`[choice-parser] event=codex-app-server-options-stale session=codex:${threadId} ${JSON.stringify({ at: new Date().toISOString(), sessionSummaryChars: normalizedSessionSummary.length, textChars: normalizedText.length })}`);
      return null;
    }
    const nextSession = {
      ...session,
      summary: text || session.summary,
      suggestedOptions: options.map((option) => ({ ...option })),
      updatedAt: now()
    };
    upsertManagedCodexSession(nextSession);
    store.setActiveChoicePrompt(sessionId, text, nextSession.suggestedOptions);
    return nextSession;
  }

  return {
    scheduleCodexChoiceParseForText, bumpChoiceGeneration,
    get pendingCount() { return pendingCodexChoiceParses.size; }
  };
}
