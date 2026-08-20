export async function loadSessionUsageSnapshot({
  loadAccount,
  loadContext,
  fallbackAccount,
  resetForecast = null
}) {
  const [accountResult, contextResult] = await Promise.allSettled([
    loadAccount(),
    loadContext()
  ]);
  return {
    account: accountResult.status === "fulfilled" && accountResult.value
      ? accountResult.value
      : fallbackAccount,
    context: contextResult.status === "fulfilled" ? contextResult.value ?? null : null,
    resetForecast
  };
}
