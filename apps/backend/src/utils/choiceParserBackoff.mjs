const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const TRANSIENT_BACKOFF_MS = 30 * 1000;

export function choiceParserRetryDelayMs(error) {
  const message = String(error?.message ?? error ?? "");
  return /\b429\b|rate limit|inference limit|service has been paused/i.test(message)
    ? RATE_LIMIT_BACKOFF_MS
    : TRANSIENT_BACKOFF_MS;
}

export function choiceParserBackoffKey(settings = {}) {
  return JSON.stringify({
    provider: settings.provider ?? "",
    model: settings.provider === "openai" ? settings.openaiModel : settings.localModel,
    endpoint: settings.provider === "openai" ? settings.openaiEndpoint : undefined
  });
}
