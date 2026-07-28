export type PwaUpdate = {
  registration: ServiceWorkerRegistration;
};

export const PWA_UPDATE_INTERVAL_MS = 60_000;

export function canRegisterPwa(
  url: Pick<Location, "protocol"> | URL = window.location,
  supported = "serviceWorker" in navigator
) {
  return supported && url.protocol === "https:";
}

export async function registerPwa(onUpdate: (update: PwaUpdate) => void) {
  if (!canRegisterPwa()) return null;
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (registration.waiting) onUpdate({ registration });
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        onUpdate({ registration });
      }
    });
  });
  return registration;
}

export function activatePwaUpdate(update: PwaUpdate) {
  update.registration.waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
}

export function createReloadOnce(reload: () => void) {
  let reloading = false;
  return () => {
    if (reloading) return;
    reloading = true;
    reload();
  };
}

export function createPwaUpdateChecker(
  registration: ServiceWorkerRegistration,
  isOnline: () => boolean = () => navigator.onLine
) {
  let checking = false;
  return async () => {
    if (checking || !isOnline()) return;
    checking = true;
    try {
      await registration.update();
    } catch {
      // Updates are opportunistic; a later focus or interval retries the check.
    } finally {
      checking = false;
    }
  };
}
