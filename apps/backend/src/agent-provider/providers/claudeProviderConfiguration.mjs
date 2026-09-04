const API_KEY_ENV = "ANTHROPIC_API_KEY";
const MODEL_ENV = "ANTHROPIC_MODEL";
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_API_KEY_LENGTH = 20;
const MAX_API_KEY_LENGTH = 512;

const ERROR_CLASSIFICATION = Object.freeze([
  { code: "AUTHENTICATION_FAILED", statusCode: 401, retryable: false, httpStatuses: [401], pattern: /authentication|invalid api key|unauthorized|401/i },
  { code: "PERMISSION_DENIED", statusCode: 403, retryable: false, httpStatuses: [403], pattern: /permission|forbidden|organization|oauth_org_not_allowed|403/i },
  { code: "RATE_LIMITED", statusCode: 429, retryable: true, httpStatuses: [429], pattern: /rate.?limit|too many requests|429/i },
  { code: "REQUEST_TIMEOUT", statusCode: 408, retryable: true, httpStatuses: [408, 504], pattern: /abort|timeout|timed out|etimedout/i },
  { code: "NETWORK_ERROR", statusCode: 503, retryable: true, httpStatuses: [], pattern: /econn|enotfound|eai_again|network|fetch failed|socket|dns/i },
  { code: "PROVIDER_SERVICE_ERROR", statusCode: 502, retryable: true, httpStatuses: [500, 502, 503], pattern: /overload|server error|service unavailable|bad gateway|\b5\d\d\b/i }
]);

export class ClaudeProviderConfigurationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ClaudeProviderConfigurationError";
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
    this.retryable = options.retryable === true;
    this.details = options.details ?? null;
  }
}

export function validateClaudeProviderConfiguration(input = {}, options = {}) {
  const configuration = plainObject(input) ? input : {};
  const errors = [];
  const apiKey = optionalString(configuration.apiKey);
  const model = optionalString(configuration.model)
    ?? optionalString(options.environment?.[MODEL_ENV]);
  const timeoutMs = optionalNumber(configuration.timeoutMs);
  const maxTurns = optionalNumber(configuration.maxTurns);
  const maxBudgetUsd = optionalNumber(configuration.maxBudgetUsd);

  if (Object.prototype.hasOwnProperty.call(configuration, "apiKey")) {
    if (!apiKey) {
      errors.push(validationError("apiKey", "API_KEY_REQUIRED", "API Key cannot be empty when supplied."));
    } else if (apiKey.length < MIN_API_KEY_LENGTH || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) {
      errors.push(validationError("apiKey", "API_KEY_INVALID", "API Key must be 20 to 512 non-whitespace characters."));
    }
  }
  if (Object.prototype.hasOwnProperty.call(configuration, "model") && !model) {
    errors.push(validationError("model", "MODEL_REQUIRED", "Model cannot be empty when supplied."));
  }
  if (model && (model.length > 200 || /[\r\n]/.test(model))) {
    errors.push(validationError("model", "MODEL_INVALID", "Model must be a single value no longer than 200 characters."));
  }
  validateIntegerRange(errors, "timeoutMs", timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  validateIntegerRange(errors, "maxTurns", maxTurns, 1, 100);
  if (maxBudgetUsd != null && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 1_000)) {
    errors.push(validationError("maxBudgetUsd", "MAX_BUDGET_INVALID", "Maximum budget must be greater than 0 and no more than 1000 USD."));
  }

  const inheritedKey = optionalString(options.environment?.[API_KEY_ENV]);
  return {
    valid: errors.length === 0,
    errors,
    configuration: {
      apiKey: {
        configured: Boolean(apiKey || inheritedKey),
        source: apiKey ? "request" : (inheritedKey ? "environment" : "claude_credentials")
      },
      model: model ?? null,
      timeoutMs: timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      maxTurns: maxTurns ?? null,
      maxBudgetUsd: maxBudgetUsd ?? null
    }
  };
}

export function claudeConnectionTestOptions(input = {}, options = {}) {
  const environment = options.environment ?? process.env;
  const validation = validateClaudeProviderConfiguration(input, { environment });
  if (!validation.valid) {
    throw new ClaudeProviderConfigurationError(
      "CLAUDE_CONFIGURATION_INVALID",
      "Claude Provider configuration is invalid.",
      { details: validation.errors }
    );
  }
  const apiKey = optionalString(input.apiKey) ?? optionalString(environment[API_KEY_ENV]);
  return {
    validation,
    timeoutMs: validation.configuration.timeoutMs,
    queryOptions: {
      env: {
        ...environment,
        ...(apiKey ? { [API_KEY_ENV]: apiKey } : {}),
        CLAUDE_AGENT_SDK_CLIENT_APP: "corptie/claude-provider"
      },
      persistSession: false,
      permissionMode: "plan",
      tools: [],
      maxTurns: validation.configuration.maxTurns ?? 1,
      ...(validation.configuration.model ? { model: validation.configuration.model } : {}),
      ...(validation.configuration.maxBudgetUsd != null
        ? { maxBudgetUsd: validation.configuration.maxBudgetUsd }
        : {})
    },
    secretValues: [apiKey].filter(Boolean)
  };
}

export function claudeRuntimeEnvironment(environment = process.env) {
  return {
    ...environment,
    CLAUDE_AGENT_SDK_CLIENT_APP: "corptie/claude-provider"
  };
}

export function normalizeClaudeProviderError(error, options = {}) {
  if (error instanceof ClaudeProviderConfigurationError) return error;
  const secretValues = Array.isArray(options.secretValues) ? options.secretValues : [];
  const rawMessage = errorMessages(error).join(" ") || "Claude Provider request failed.";
  const explicitStatus = httpStatus(error);
  const classification = ERROR_CLASSIFICATION.find((item) => (
    item.httpStatuses.includes(explicitStatus) || item.pattern.test(rawMessage)
  ));
  const code = sdkErrorCode(error) ?? classification?.code ?? "CLAUDE_REQUEST_FAILED";
  const statusCode = classification?.statusCode ?? (explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus : 502);
  const retryable = classification?.retryable ?? statusCode >= 500;
  const message = publicMessageForCode(code);
  return new ClaudeProviderConfigurationError(code, redactClaudeSecrets(message, secretValues), {
    statusCode,
    retryable
  });
}

export function redactClaudeSecrets(value, secretValues = []) {
  let result = String(value ?? "");
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:api[-_ ]?key|authorization|bearer|token)\s*[:=]?\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function claudeSdkResultError(message, options = {}) {
  if (message?.subtype === "success" && message?.is_error !== true) return null;
  return normalizeClaudeProviderError({
    code: message?.error ?? message?.terminal_reason ?? message?.subtype,
    status: message?.api_error_status,
    message: [
      ...(Array.isArray(message?.errors) ? message.errors : []),
      typeof message?.result === "string" ? message.result : ""
    ].filter(Boolean).join(" ") || String(message?.subtype ?? "Claude request failed")
  }, options);
}

function sdkErrorCode(error) {
  const value = String(error?.code ?? "").toLowerCase();
  if (value === "authentication_failed") return "AUTHENTICATION_FAILED";
  if (value === "oauth_org_not_allowed") return "PERMISSION_DENIED";
  if (value === "rate_limit") return "RATE_LIMITED";
  if (value === "overloaded" || value === "server_error") return "PROVIDER_SERVICE_ERROR";
  return null;
}

function publicMessageForCode(code) {
  return {
    AUTHENTICATION_FAILED: "Claude authentication failed. Check the configured API Key or Claude credentials.",
    PERMISSION_DENIED: "Claude denied this request. Check organization and model permissions.",
    RATE_LIMITED: "Claude rate limit reached. Retry after the provider reset window.",
    REQUEST_TIMEOUT: "Claude request timed out. Retry when the network is stable.",
    NETWORK_ERROR: "Claude could not be reached because of a network error.",
    PROVIDER_SERVICE_ERROR: "Claude service is temporarily unavailable.",
    CLAUDE_REQUEST_FAILED: "Claude Provider request failed."
  }[code] ?? "Claude Provider request failed.";
}

function errorMessages(error) {
  if (typeof error === "string") return [error];
  if (!error || typeof error !== "object") return [];
  return [error.message, error.error, error.detail, error.code, ...(Array.isArray(error.errors) ? error.errors : [])]
    .filter((value) => typeof value === "string" && value.trim());
}

function httpStatus(error) {
  for (const value of [error?.status, error?.statusCode, error?.response?.status, error?.api_error_status]) {
    const number = Number(value);
    if (Number.isInteger(number)) return number;
  }
  return 0;
}

function validationError(field, code, message) {
  return { field, code, message };
}

function validateIntegerRange(errors, field, value, minimum, maximum) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(validationError(field, `${field.toUpperCase()}_INVALID`, `${field} must be an integer from ${minimum} to ${maximum}.`));
  }
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  return typeof value === "number" ? value : Number(value);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
