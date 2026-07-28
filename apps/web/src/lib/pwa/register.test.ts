import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canRegisterPwa,
  createPwaUpdateChecker,
  createReloadOnce
} from "./register";

describe("PWA security policy", () => {
  it("registers only in an HTTPS secure context", () => {
    expect(canRegisterPwa(new URL("https://192.168.1.5:47323"), true)).toBe(true);
    expect(canRegisterPwa(new URL("http://192.168.1.5:47323"), true)).toBe(false);
    expect(canRegisterPwa(new URL("https://192.168.1.5:47323"), false)).toBe(false);
  });

  it("keeps API and pairing traffic outside the service-worker cache", () => {
    const source = readFileSync(join(process.cwd(), "src", "lib", "pwa", "sw-template.js"), "utf8");
    expect(source).toContain('const BLOCKED_PREFIXES = ["/api/", "/pair/"]');
    expect(source).toContain("__CORPTIE_BUILD_VERSION__");
    expect(source).toContain('request.method !== "GET"');
    expect(source).not.toContain('addEventListener("sync"');
    expect(source).not.toContain("indexedDB");
  });

  it("reloads only once when a new service worker takes control", () => {
    const reload = vi.fn();
    const reloadOnce = createReloadOnce(reload);
    reloadOnce();
    reloadOnce();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("checks for updates only when online and never overlaps checks", async () => {
    let resolveUpdate = () => {};
    const update = vi.fn(() => new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));
    let online = false;
    const check = createPwaUpdateChecker(
      { update } as unknown as ServiceWorkerRegistration,
      () => online
    );

    await check();
    expect(update).not.toHaveBeenCalled();

    online = true;
    const first = check();
    void check();
    expect(update).toHaveBeenCalledTimes(1);
    resolveUpdate();
    await first;
    void check();
    expect(update).toHaveBeenCalledTimes(2);
  });
});
