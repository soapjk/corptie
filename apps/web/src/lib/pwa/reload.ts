export async function reloadPwa() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch {
    // Reload remains useful when the service worker update check is unavailable.
  }
  window.location.reload();
}
