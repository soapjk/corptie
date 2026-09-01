export function historicalProviderSessionUnavailable(value) {
  return /(?:no rollout found for thread id\b|failed to resolve rollout path\b.*\bfile does not exist)/i
    .test(String(value ?? ""));
}
