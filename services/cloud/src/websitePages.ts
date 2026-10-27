import type { DownloadCatalog } from "./downloads.js";
import { ACCOUNT_JS, BROWSER_HTTP_JS, SITE_CSS, WEBSITE_THEME_CSS } from "./websiteAssets.js";
import { asset, escapeHtml, renderDocument, renderSiteHeader, renderSiteFooter } from "./websiteHtml.js";

interface WebsiteOptions {
  baseURL: string;
  version: string;
  downloads: DownloadCatalog;
  publicRegistration: boolean;
  environment: "development" | "test" | "production";
}

function layout(content: string, current: "home" | "download" | "account" = "home"): string {
  return `${renderSiteHeader({ current })}${content}${renderSiteFooter()}`;
}

function renderProductPreview(kind: "workspace" | "cross-device"): string {
  const task = `<div class="preview-task"><span class="badge">待检查</span><h3>准备项目发布</h3><p>Session 已完成本轮执行，等待检查结果。</p></div>`;
  const body = kind === "workspace"
    ? `<div class="workspace-preview"><div class="preview-toolbar"><strong>Corptie / 示例项目</strong><span>项目 · 任务 · 执行</span></div><div class="preview-layout"><div class="preview-sidebar" aria-hidden="true"><p>工作空间</p><p class="selected">示例项目</p><p>发布准备</p><p>交付文件</p></div><div class="preview-content"><p class="eyebrow">WORK / 示例项目</p><h3>让每一步，都有清晰的去向。</h3><div class="preview-columns">${task}<div class="preview-task"><strong>执行与交付</strong><ol><li>明确任务与验收标准</li><li>由 Session 推进执行</li><li>检查修改与交付文件</li></ol></div></div></div></div></div>`
    : `<div class="phone-preview"><p>Corptie · 移动端</p><h3>项目进展，随时接续。</h3>${task}<div class="preview-task"><strong>桌面端连接</strong><p>登录同一 Cloud 账号，连接 Mac，查看工作并参与交互。</p></div></div>`;
  return `<figure class="product-preview">${body}<figcaption class="preview-caption">界面示意 · 示例内容，非实际运行状态</figcaption></figure>`;
}

function renderHomeHero(options: { publicRegistration: boolean }): string {
  return `<section class="hero"><p class="eyebrow">CORPTIE · 为持续推进的工作而设计</p><h1>把项目、任务与 AI 执行，<br>放进同一个工作台。</h1><p class="lead">连接本地项目、任务与 Session，让执行、协作和交付有序衔接。在 Mac 上专注工作，在移动端继续参与。</p><div class="actions"><a class="button primary" href="/download">下载 Corptie</a><a class="button" href="#workflow">了解工作流程</a></div><p class="tag">macOS 桌面端 · iPhone 与 iPad 移动端${options.publicRegistration ? ' · <a href="/auth/sign-up">创建账号</a>' : ""}</p>${renderProductPreview("workspace")}</section>`;
}

function renderWorkflowSection(): string {
  const steps = [
    ["01 / WORK", "从项目出发", "关联本地项目，整理背景与长期目标。"],
    ["02 / TASK", "明确这次要做什么", "将目标拆成具体任务，写清验收标准。"],
    ["03 / SESSION", "让执行持续推进", "由 Session 执行，按需协作、审批与跟进。"],
    ["04 / DELIVERY", "检查，然后交付", "查看修改、验证证据与交付文件，再完成合并。"]
  ];
  return `<section id="workflow" aria-labelledby="workflow-title"><div class="section-intro"><p class="eyebrow">从想法到交付</p><h2 id="workflow-title">每一步，都在同一条工作流程里。</h2><p>项目保留背景，任务定义目标，Session 推进执行。结果也有清楚的归处。</p></div><ol class="workflow">${steps.map(([number, title, text]) => `<li><span>${number}</span><h3>${title}</h3><p>${text}</p></li>`).join("")}</ol></section>`;
}

function renderCrossDeviceSection(): string {
  return `<section class="cross-device" aria-labelledby="mobile-title"><div><p class="eyebrow">桌面执行 · 移动参与</p><h2 id="mobile-title">离开桌面，<br>工作也能接续。</h2><p class="lead">Mac 负责本地项目与运行环境。移动端通过 Corptie Cloud 与桌面端建立连接，让你继续查看进展、参与交互。</p><a href="/download">查看平台与安装要求 →</a></div>${renderProductPreview("cross-device")}</section>`;
}

export function renderHomePage(publicRegistration: boolean): string {
  const features = [
    ["项目与任务", "给工作一个清晰的上下文", "用 Work 组织项目与长期背景，用 Task 明确目标与验收标准；资料与交付文件由 Artifacts 管理。"],
    ["执行与协作", "按工作需要，安排执行", "通过 Agent 配置与 Skills 定义工作方式，由 Session 执行任务，并通过授权 Channel 协作。支持不同 Provider 运行环境。"],
    ["代码与交付", "从独立修改，到检查合并", "将任务关联到本地仓库与 Worktree，在独立工作目录中推进修改，检查结果后再合并交付。"]
  ];
  return layout(`<main id="main" class="wrap">${renderHomeHero({ publicRegistration })}${renderWorkflowSection()}<section id="features" aria-labelledby="features-title"><div class="section-intro"><p class="eyebrow">围绕真实工作</p><h2 id="features-title">让工具衔接起来，让注意力留给工作。</h2></div><div class="grid">${features.map(([label, title, text]) => `<article class="panel"><span class="feature-number">${label}</span><h3>${title}</h3><p>${text}</p></article>`).join("")}</div></section>${renderCrossDeviceSection()}<section class="closing panel"><h2>从下一项工作开始。</h2><p>准备你的项目，让想法一步步成为可以交付的结果。</p><div class="actions"><a class="button primary" href="/download">下载 Corptie</a><a href="/account">我的账号 →</a></div></section></main>`);
}

export function renderDownloadPage(catalog: DownloadCatalog): string {
  const mac = catalog.macOS;
  const buttons = [mac.dmgURL ? `<a class="button primary" href="${escapeHtml(mac.dmgURL)}" rel="noopener noreferrer">下载 DMG</a>` : "", mac.pkgURL ? `<a class="button" href="${escapeHtml(mac.pkgURL)}" rel="noopener noreferrer">下载 PKG</a>` : ""].join("");
  return layout(`<main id="main" class="wrap"><section><p class="eyebrow">下载与安装</p><h1>为你的工作设备<br>准备 Corptie。</h1><p class="lead">桌面端运行本地工作，移动端连接桌面端。选择适合设备的版本，并查看安装要求。</p></section><section class="platforms" aria-label="平台下载"><article class="panel"><span class="platform-label">桌面工作台</span><h2>macOS</h2><p class="tag">Apple Silicon · macOS 14 或更高版本</p>${buttons ? `<p>版本 ${escapeHtml(mac.version ?? "")}</p><div class="actions">${buttons}</div><p class="muted">安装包来自 GitHub Releases，点击后将前往官方发布资产。</p>` : '<p class="status">正式安装包暂未开放下载。</p>'}</article><article class="panel"><span class="platform-label">随时参与</span><h2>iPhone 与 iPad</h2>${catalog.iOSURL ? `<p>通过发布页面查看设备兼容性与安装要求。</p><div class="actions"><a class="button" href="${escapeHtml(catalog.iOSURL)}" rel="noopener noreferrer">${new URL(catalog.iOSURL).hostname === "testflight.apple.com" ? "通过 TestFlight 安装" : "前往 App Store"}</a></div>` : '<p class="status">移动端下载入口待发布。</p>'}</article></section><section aria-labelledby="install-title"><h2 id="install-title">开始使用</h2><ol class="steps"><li>下载并安装对应平台的正式版本。</li><li>在 Mac 上准备项目，以及已经完成认证的 Provider 运行环境。</li><li>创建 Work 和 Task，由 Session 推进具体工作。</li><li>需要移动连接时，在桌面端与移动端登录同一 Corptie Cloud 账号。</li></ol>${catalog.notesURL ? `<p><a href="${escapeHtml(catalog.notesURL)}" rel="noopener noreferrer">查看版本发布说明 →</a></p>` : ""}</section></main>`, "download");
}

export function renderAccountPage(): string {
  return layout(`<main id="main" class="wrap narrow" data-account-page><section><p class="eyebrow">Corptie Cloud</p><h1 class="account-title">我的账号</h1><p class="lead">查看账号资料与已登记设备。</p><noscript><p>此页需要 JavaScript 才能检查登录状态并加载你的账号资料。</p><a href="/auth/sign-in">前往登录</a></noscript><p class="status" data-account-status role="status" aria-live="polite">正在检查登录状态…</p><button type="button" data-retry hidden>重新加载账号</button></section><div data-profile hidden><section class="panel" aria-labelledby="profile-title"><h2 id="profile-title">基本资料</h2><dl><dt>姓名</dt><dd data-name></dd><dt>邮箱</dt><dd data-email></dd><dt>邮箱验证</dt><dd data-verified></dd><dt>注册时间</dt><dd data-created></dd></dl><div class="actions"><a href="/auth/recover">找回账号或重置密码</a><button type="button" data-sign-out disabled>退出登录</button></div></section><section class="panel" aria-labelledby="devices-title"><h2 id="devices-title">已登记设备</h2><p class="muted">登记信息不代表设备当前在线。连接状态请以客户端为准。</p><p class="status" data-device-status role="status" aria-live="polite"></p><ul class="devices" data-devices></ul><button type="button" data-device-retry hidden>重新加载设备</button></section></div></main>`, "account");
}

export function renderRobotsTxt(baseURL: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /auth/\nDisallow: /api/\nDisallow: /v1/\nSitemap: ${baseURL}/sitemap.xml\n`;
}

export function renderSitemap(baseURL: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/download"].map(path => `<url><loc>${escapeHtml(baseURL + path)}</loc></url>`).join("")}</urlset>`;
}

export function createWebsiteHandler(options: WebsiteOptions): (request: Request) => Promise<Response | null> {
  const cache = options.environment === "production" ? "public, max-age=60" : "no-store";
  const assetsCache = options.environment === "production" ? "public, max-age=3600" : "no-store";
  const document = (path: string, title: string, description: string, body: string, account = false) => renderDocument({
    title, description, body, styles: ["/assets/theme.css", "/assets/site.css"],
    scripts: account ? ["/assets/web-http.js", "/assets/account.js"] : [],
    ...(account ? { noIndex: true } : { canonicalURL: options.baseURL + path }),
    assetVersion: options.version, cacheControl: account ? "no-store" : cache
  });
  const responses = new Map<string, Response>([
    ["/", document("/", "项目、任务与执行", "Corptie 将项目、任务、Session、Agent 和 Git 工具连接在一起，形成从想法到交付的工作流程。", renderHomePage(options.publicRegistration))],
    ["/download", document("/download", "下载 Corptie", "查看 Corptie 的平台、系统要求、正式下载入口与安装说明。", renderDownloadPage(options.downloads))],
    ["/account", document("/account", "我的账号", "查看 Corptie Cloud 账号资料与已登记设备。", renderAccountPage(), true)],
    ["/assets/theme.css", asset(WEBSITE_THEME_CSS, "text/css; charset=utf-8", assetsCache)],
    ["/assets/site.css", asset(SITE_CSS, "text/css; charset=utf-8", assetsCache)],
    ["/assets/web-http.js", asset(BROWSER_HTTP_JS, "text/javascript; charset=utf-8", assetsCache)],
    ["/assets/account.js", asset(ACCOUNT_JS, "text/javascript; charset=utf-8", assetsCache)],
    ["/robots.txt", asset(renderRobotsTxt(options.baseURL), "text/plain; charset=utf-8", cache)],
    ["/sitemap.xml", asset(renderSitemap(options.baseURL), "application/xml; charset=utf-8", cache)]
  ]);
  // Store encoded bodies, not Response.clone() tee branches: a long-lived
  // unconsumed clone would retain queued stream chunks on every request.
  const encoded = new Map([...responses].map(([path, response]) => [path, {
    headers: response.headers, bytes: response.arrayBuffer()
  }]));
  // Bodies are small immutable byte arrays. Each request gets a fresh stream.
  return async request => {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const path = new URL(request.url).pathname;
    const entry = encoded.get(path);
    if (!entry) return null;
    return new Response(request.method === "HEAD" ? null : await entry.bytes, { headers: entry.headers });
  };
}
