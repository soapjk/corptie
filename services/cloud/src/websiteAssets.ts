export const WEBSITE_THEME_CSS = `
:root{color-scheme:light dark;font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#f6f7f9;--text:#1a1f21;--muted:#58636c;--accent:#365f94;--line:rgba(37,54,74,.14);--surface:rgba(255,255,255,.78);--solid:#fff;--nav:rgba(255,255,255,.88);--tint:#e9eff7;--shadow:0 12px 36px rgba(32,51,77,.055);--radius:20px}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 80% 0%,rgba(175,199,232,.23),transparent 45rem),var(--bg);color:var(--text)}a{color:var(--accent);text-underline-offset:4px}a,button{touch-action:manipulation}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid Highlight;outline-offset:4px}[hidden]{display:none!important}
.wrap{width:min(1080px,calc(100% - 48px));margin-inline:auto}.site-header{padding-top:20px}.nav-shell{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:8px 18px;background:var(--solid);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.brand{display:inline-flex;align-items:center;gap:9px;font-size:1.05rem;font-weight:650;letter-spacing:-.04em;text-decoration:none;color:var(--text)}.brand-symbol{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:9px;background:var(--tint);color:var(--accent);font-size:17px}.site-header nav,.site-footer nav{display:flex;flex-wrap:wrap;align-items:center;gap:4px 20px}.site-header nav a{display:inline-flex;align-items:center;min-height:40px;font-size:.85rem;color:var(--muted);text-decoration:none}.site-header nav a:hover,.site-header nav a[aria-current]{color:var(--text)}.site-header nav a[aria-current]{text-decoration:underline}.skip{position:absolute;z-index:2;top:8px;left:8px;transform:translateY(-200%);padding:8px 16px;background:var(--solid)}.skip:focus{transform:none}
.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;border:1px solid var(--line);border-radius:12px;background:var(--solid);color:var(--text);font:inherit;font-size:.95rem;font-weight:550;text-decoration:none;cursor:pointer}.primary{background:var(--text);color:var(--bg)}.button:hover,button:hover{border-color:var(--accent)}button:disabled{opacity:.6;cursor:wait}.panel{border:1px solid var(--line);border-radius:var(--radius);padding:28px;background:var(--surface);box-shadow:var(--shadow)}.muted,.tag{color:var(--muted)}.tag{font-size:.8rem}.status{color:var(--muted);min-height:26px}.status[data-error="true"]{color:#b42318}p{overflow-wrap:anywhere}.site-footer{border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:.8rem}.site-footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.site-footer a{color:var(--muted)}
@supports ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.nav-shell{background:var(--nav);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}}
@media(prefers-color-scheme:dark){:root{--bg:#111518;--text:#f0f5f5;--muted:#a7b4c0;--accent:#9cbbe2;--line:rgba(202,220,240,.17);--surface:rgba(30,37,44,.88);--solid:#1c232a;--nav:rgba(28,35,42,.9);--tint:#273747;--shadow:0 12px 36px rgba(0,0,0,.12)}body{background:radial-gradient(ellipse at 80% 0%,rgba(66,94,128,.17),transparent 45rem),var(--bg)}.status[data-error="true"]{color:#ffb4ab}}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){:root{--surface:var(--solid)}body{background:var(--bg)}.panel,.nav-shell{background:var(--solid);-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none}}
@media(prefers-contrast:more){:root{--line:currentColor;--muted:var(--text)}}
@media(forced-colors:active){.panel,.nav-shell,.button,button{border:1px solid CanvasText;box-shadow:none}.nav-shell{-webkit-backdrop-filter:none;backdrop-filter:none}.brand-symbol{background:Canvas;color:CanvasText}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media(max-width:700px){.wrap{width:calc(100% - 32px)}.site-header{padding-top:12px}.nav-shell{flex-wrap:wrap;padding:10px 14px;gap:4px 20px}.site-header nav{gap:0 16px}.site-header nav a{min-height:44px}.panel{padding:22px}}
`;

export const SITE_CSS = `
main{padding:88px 0 96px}.eyebrow{font-size:.76rem;font-weight:600;letter-spacing:.12em;color:var(--accent);margin:0 0 18px}h1{font-size:clamp(2.125rem,5.8vw,4rem);font-weight:550;line-height:1.2;letter-spacing:-.055em;max-width:18ch;margin:0 0 24px;text-wrap:balance}h2{font-size:clamp(1.6rem,3vw,2.25rem);font-weight:550;line-height:1.3;letter-spacing:-.04em;margin:0 0 20px}h3{font-size:1.12rem;font-weight:600;margin:0 0 12px}p{margin:0 0 20px}.lead{font-size:1.1rem;max-width:58ch;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:28px 0}.hero{text-align:center}.hero h1,.hero .lead{margin-inline:auto}.hero .actions{justify-content:center}.hero h1{max-width:19ch}.hero>.tag{margin-bottom:36px}main>section+section{margin-top:96px}.section-intro{max-width:62ch;margin-bottom:32px}.section-intro p{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.grid p{color:var(--muted);margin-bottom:0}.feature-number{display:block;color:var(--accent);font-size:.8rem;margin-bottom:24px}.steps{padding-left:24px;max-width:70ch}.steps li{padding:8px 0 8px 8px}.workflow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;padding:0;list-style:none}.workflow li{border-top:1px solid var(--line);padding-top:20px}.workflow span{display:block;color:var(--accent);font-size:.8rem;margin-bottom:12px}.workflow p{font-size:.9rem;color:var(--muted);margin-bottom:0}.platforms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.platforms h2{margin-top:20px}.platforms .actions{margin-bottom:18px}.platform-label{font-size:.8rem;color:var(--accent)}.narrow{max-width:800px}.account-title{font-size:clamp(2rem,5vw,3rem)}[data-profile]>section+section{margin-top:28px}dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:0 24px;margin:0}dt,dd{padding:14px 0;border-bottom:1px solid var(--line)}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.devices{padding:0;list-style:none;margin:0}.devices li{padding:16px 0;border-bottom:1px solid var(--line)}.devices p{margin:4px 0 0;font-size:.9rem;color:var(--muted)}.closing{text-align:center}.closing .actions{justify-content:center}.closing p{color:var(--muted)}
.product-preview{margin:0;text-align:left}.preview-caption{font-size:.75rem;color:var(--muted);text-align:center;margin-top:16px}.workspace-preview{border:1px solid var(--line);border-radius:24px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow)}.preview-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px 22px;border-bottom:1px solid var(--line);font-size:.8rem;color:var(--muted)}.preview-toolbar strong{color:var(--text);font-weight:550}.preview-layout{display:grid;grid-template-columns:190px minmax(0,1fr)}.preview-sidebar{padding:26px 20px;border-right:1px solid var(--line);font-size:.8rem}.preview-sidebar p{padding:9px 12px;margin-bottom:8px;border-radius:9px}.preview-sidebar .selected{background:var(--tint);color:var(--accent)}.preview-content{padding:30px}.preview-content h3{font-size:1.2rem}.preview-columns{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px}.preview-task{padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--solid)}.preview-task p{font-size:.85rem;color:var(--muted);margin:12px 0 0}.preview-task strong{font-size:.9rem;font-weight:550}.badge{display:inline-block;font-size:.7rem;color:var(--accent);background:var(--tint);padding:3px 9px;border-radius:6px;margin-bottom:12px}.preview-task ol{padding-left:20px;margin-bottom:0;color:var(--muted);font-size:.85rem}.preview-task li{margin-top:10px}.cross-device{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:center}.cross-device .product-preview{max-width:320px;margin-inline:auto;width:100%}.phone-preview{padding:22px;border:1px solid var(--line);border-radius:28px;background:var(--surface);box-shadow:var(--shadow)}.phone-preview>p{font-size:.85rem;color:var(--muted)}.phone-preview .preview-task+.preview-task{margin-top:12px}
@media(max-width:700px){main{padding:52px 0 64px}main>section+section{margin-top:56px}.grid,.platforms,.cross-device{grid-template-columns:1fr}.workflow{grid-template-columns:repeat(2,minmax(0,1fr));gap:24px 20px}.preview-layout{grid-template-columns:1fr}.preview-sidebar{display:none}.preview-content{padding:20px}.preview-columns{grid-template-columns:1fr}.preview-toolbar{padding:12px 18px}.cross-device{gap:28px}dl{grid-template-columns:1fr;gap:0}dt{padding-bottom:0;border-bottom:0}dd{padding-top:4px}.hero h1{max-width:17ch}}
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
