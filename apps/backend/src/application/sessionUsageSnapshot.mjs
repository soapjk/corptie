export async function loadSessionUsageSnapshot({
  loadAccount,
  loadContext,
  fallbackAccount,
  persistAccount = null,
  resetForecast = null
}) {
  const [accountResult, contextResult] = await Promise.allSettled([
    loadAccount(),
    loadContext()
  ]);
  const loadedAccount = accountResult.status === "fulfilled" && accountResult.value
    ? accountResult.value
    : null;
  if (loadedAccount && typeof persistAccount === "function") {
    await persistAccount(loadedAccount);
  }
  return {
    account: loadedAccount ?? fallbackAccount,
    accountFresh: loadedAccount !== null,
    context: contextResult.status === "fulfilled" ? contextResult.value ?? null : null,
    resetForecast
  };
}
