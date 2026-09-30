export async function loadSessionUsageSnapshot({
  loadAccount,
  loadContext,
  fallbackAccount,
  requireFreshAccount = false,
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
  if (requireFreshAccount && !loadedAccount) {
    const error = new Error("Account usage could not be refreshed.");
    error.code = "ACCOUNT_USAGE_REFRESH_FAILED";
    throw error;
  }
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
