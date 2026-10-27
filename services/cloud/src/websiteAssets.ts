export const SITE_CSS = `
:root{color-scheme:light dark;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--muted:color-mix(in srgb,CanvasText 65%,Canvas);--line:color-mix(in srgb,CanvasText 15%,Canvas)}
*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText}a{color:LinkText;text-underline-offset:4px}a,button{touch-action:manipulation}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid Highlight;outline-offset:4px}[hidden]{display:none!important}
.wrap{width:min(1080px,calc(100% - 48px));margin:auto}header{border-bottom:1px solid var(--line)}header .wrap{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:80px}.brand{font-size:1.2rem;letter-spacing:-.04em;font-weight:750;text-decoration:none;color:CanvasText}nav{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px}nav a{font-size:.9rem;color:CanvasText}.skip{position:absolute;top:8px;left:8px;transform:translateY(-200%);padding:8px;background:Canvas}.skip:focus{transform:none}
main{padding:72px 0 96px}.eyebrow{font-size:.8rem;font-weight:650;letter-spacing:.1em;color:var(--muted);margin:0 0 20px}h1{font-size:clamp(2.1rem,6vw,4.2rem);line-height:1.14;letter-spacing:-.055em;max-width:17ch;margin:0 0 24px;text-wrap:balance}h2{font-size:1.6rem;line-height:1.3;letter-spacing:-.035em;margin:0 0 20px}h3{font-size:1.05rem;margin:0 0 10px}p{margin:0 0 20px;overflow-wrap:anywhere}.lead{font-size:1.1rem;max-width:64ch;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:28px 0}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;border:1px solid var(--line);border-radius:9px;background:Canvas;color:CanvasText;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.primary{background:CanvasText;color:Canvas}.button:hover,button:hover{border-color:CanvasText}button:disabled{opacity:.6;cursor:wait}section+section{margin-top:72px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px 28px}.grid article{border-top:1px solid var(--line);padding-top:20px}.grid p,.muted{color:var(--muted)}.steps{padding-left:24px;max-width:70ch}.steps li{padding:8px 0 8px 8px}.platforms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.panel{border:1px solid var(--line);border-radius:14px;padding:28px}.tag{font-size:.8rem;color:var(--muted)}.status{color:var(--muted);min-height:26px}.status[data-error="true"]{color:#b42318}dl{display:grid;grid-template-columns:110px 1fr;gap:12px 24px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.devices{padding:0;list-style:none}.devices li{padding:16px 0;border-bottom:1px solid var(--line)}.devices p{margin:4px 0 0;font-size:.9rem;color:var(--muted)}footer{border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:.85rem}footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.narrow{max-width:800px}.account-title{font-size:clamp(2rem,5vw,3rem)}
@media(prefers-color-scheme:dark){.status[data-error="true"]{color:#ffb4ab}}@media(max-width:700px){.wrap{width:calc(100% - 32px)}header .wrap{align-items:flex-start;padding-top:20px;padding-bottom:20px;gap:16px}nav{gap:10px 16px}main{padding:48px 0 64px}.grid,.platforms{grid-template-columns:1fr}.panel{padding:22px}section+section{margin-top:48px}dl{grid-template-columns:1fr;gap:4px}dd+dt{margin-top:12px}}
`;

export const BROWSER_HTTP_JS = `
globalThis.CorptieWeb = Object.freeze({
  async requestJson(path, options = {}) {
    const url = new URL(path, window.location.origin);
    if (!path.startsWith("/") || path.startsWith("//") || url.origin !== window.location.origin) throw new Error("请求地址无效。");
    const response = await fetch(url.href, {
      method: options.method || "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
      headers: options.body === undefined ? {} : { "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error("服务器响应无效，请稍后重试。"); }
    if (!response.ok) {
      const message = response.status >= 500 ? "服务暂不可用，请稍后重试。" : payload?.message;
      const error = new Error(typeof message === "string" ? message.slice(0, 400) : "请求未完成，请稍后重试。");
      error.code = payload?.code; error.status = response.status;
      throw error;
    }
    return payload;
  }
});
`;

export const ACCOUNT_JS = `
(() => {
  const root = document.querySelector("[data-account-page]");
  if (!root) return;
  const status = root.querySelector("[data-account-status]");
  const deviceStatus = root.querySelector("[data-device-status]");
  const profile = root.querySelector("[data-profile]");
  const retry = root.querySelector("[data-retry]");
  const deviceRetry = root.querySelector("[data-device-retry]");
  const exit = root.querySelector("[data-sign-out]");
  const list = root.querySelector("[data-devices]");
  let controller;
  function setStatus(container, message, failed = false) {
    container.textContent = message; container.dataset.error = String(failed);
  }
  function date(value) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("zh-CN") : "未提供";
  }
  async function loadSession(signal) {
    const result = await CorptieWeb.requestJson("/api/auth/get-session", { signal });
    if (result === null) return null;
    if (!result?.user || typeof result.user.id !== "string" || typeof result.user.email !== "string") throw new Error("账号信息暂不可用，请重试。");
    const user = result.user;
    return { name: typeof user.name === "string" ? user.name : "未填写", email: user.email,
      emailVerified: user.emailVerified === true, createdAt: user.createdAt };
  }
  function renderUser(user) {
    root.querySelector("[data-name]").textContent = user.name;
    root.querySelector("[data-email]").textContent = user.email;
    root.querySelector("[data-verified]").textContent = user.emailVerified ? "已验证" : "尚未验证";
    root.querySelector("[data-created]").textContent = date(user.createdAt);
  }
  function renderDevices(devices) {
    const nodes = devices.slice(0, 200).map(device => {
      const item = document.createElement("li");
      const name = document.createElement("strong"); name.textContent = device.displayName;
      const detail = document.createElement("p");
      detail.textContent = (device.kind === "mac" ? "Mac" : "移动设备") + " · " + (device.revokedAt ? "已撤销" : "已登记") + " · 最近登记更新：" + date(device.updatedAt);
      item.append(name, detail); return item;
    });
    list.replaceChildren(...nodes);
    setStatus(deviceStatus, devices.length ? "共 " + devices.length + " 台设备" + (devices.length > 200 ? "，显示前 200 台。" : "。") : "还没有登记设备。登录桌面端或移动端后，设备会显示在这里。");
  }
  async function loadDevices(signal) {
    deviceRetry.hidden = true; list.replaceChildren(); setStatus(deviceStatus, "正在加载设备…");
    try {
      const result = await CorptieWeb.requestJson("/v1/devices", { signal });
      if (signal.aborted) return;
      if (!Array.isArray(result?.devices)) throw new Error("设备信息暂不可用，请重试。");
      renderDevices(result.devices);
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 401) { window.location.replace("/auth/sign-in"); return; }
      setStatus(deviceStatus, error instanceof Error ? error.message : "设备加载失败。", true); deviceRetry.hidden = false;
    }
  }
  async function initializeAccountPage() {
    controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    retry.hidden = true; profile.hidden = true; exit.disabled = true;
    setStatus(status, "正在检查登录状态…"); root.setAttribute("aria-busy", "true");
    try {
      const user = await loadSession(signal);
      if (signal.aborted) return;
      if (!user) { window.location.replace("/auth/sign-in"); return; }
      renderUser(user); profile.hidden = false; exit.disabled = false; setStatus(status, "");
      await loadDevices(signal);
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 401) { window.location.replace("/auth/sign-in"); return; }
      setStatus(status, error instanceof Error ? error.message : "账号加载失败。", true); retry.hidden = false;
    } finally { if (!signal.aborted) root.removeAttribute("aria-busy"); }
  }
  async function signOut() {
    exit.disabled = true; controller?.abort();
    try {
      await CorptieWeb.requestJson("/api/auth/sign-out", { method: "POST", body: {} });
      profile.hidden = true; list.replaceChildren(); window.location.replace("/");
    } catch (error) {
      controller = new AbortController();
      setStatus(status, error instanceof Error ? error.message : "退出失败，请重试。", true); exit.disabled = false;
    } finally { root.removeAttribute("aria-busy"); }
  }
  retry.addEventListener("click", () => void initializeAccountPage());
  deviceRetry.addEventListener("click", () => { if (controller && !controller.signal.aborted) void loadDevices(controller.signal); });
  exit.addEventListener("click", () => void signOut());
  window.addEventListener("pagehide", () => controller?.abort());
  window.addEventListener("pageshow", event => { if (event.persisted) void initializeAccountPage(); });
  void initializeAccountPage();
})();
`;
