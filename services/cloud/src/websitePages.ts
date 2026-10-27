import type { DownloadCatalog } from "./downloads.js";
import { ACCOUNT_JS, BROWSER_HTTP_JS, SITE_CSS } from "./websiteAssets.js";
import { asset, escapeHtml, renderDocument } from "./websiteHtml.js";

interface WebsiteOptions {
  baseURL: string;
  version: string;
  downloads: DownloadCatalog;
  publicRegistration: boolean;
  environment: "development" | "test" | "production";
}

function layout(content: string): string {
  return `<a class="skip" href="#main">跳到主要内容</a><header><div class="wrap"><a class="brand" href="/" aria-label="Corptie 首页">Corptie</a><nav aria-label="主导航"><a href="/#features">功能</a><a href="/download">下载</a><a href="/account">我的账号</a></nav></div></header>${content}<footer><div class="wrap"><span>Corptie · 将项目、任务与执行连接起来</span><nav aria-label="页脚导航"><a href="/">首页</a><a href="/download">下载</a></nav></div></footer>`;
}

export function renderHomePage(publicRegistration: boolean): string {
  const features = [
    ["Work 与 Task", "将项目背景、具体任务与交付目标组织在一起，让每一次执行都有清晰的上下文。"],
    ["Session 协作", "Session 执行任务，也可以通过授权的 Channel 与其他 Session 沟通，减少手动搬运上下文。"],
    ["Agent 与 Skills", "按工作需要配置角色、工作方式和 Skills，并使用支持的 Provider 运行环境。"],
    ["Worktree 与 Git", "任务关联本地仓库与独立工作目录，从代码修改到检查、合并形成完整的工作流程。"],
    ["Artifacts", "集中管理工作中的资料与交付文件，保留版本，让后续任务可以继续使用。"],
    ["移动端连接", "通过 Corptie Cloud 登录、发现设备并连接 Mac，在移动端继续参与桌面端的工作。"]
  ];
  return layout(`<main id="main" class="wrap"><section><p class="eyebrow">项目 · 任务 · 执行</p><h1>把想法推进到<br>可以交付的结果。</h1><p class="lead">Corptie 将项目、任务、Agent 和 Git 工具连接在一起。由 Session 推进执行，在同一个工作流程中管理上下文、协作与交付。</p><div class="actions"><a class="button primary" href="/download">下载 Corptie</a><a class="button" href="/auth/sign-in">登录账号</a>${publicRegistration ? '<a href="/auth/sign-up">创建账号</a>' : ""}</div><p class="tag">macOS 桌面端 · iPhone 与 iPad 移动端</p></section><section id="features" aria-labelledby="features-title"><h2 id="features-title">围绕真实工作的工具</h2><div class="grid">${features.map(([title, text]) => `<article><h3>${title}</h3><p>${text}</p></article>`).join("")}</div></section><section aria-labelledby="workflow-title"><h2 id="workflow-title">从建立项目，到检查交付</h2><ol class="steps"><li><strong>建立 Work。</strong> 关联本地项目，整理背景与长期目标。</li><li><strong>创建 Task。</strong> 明确需要完成的工作和验收标准。</li><li><strong>由 Session 执行。</strong> 使用合适的 Agent 配置与 Provider，按需协作和审批。</li><li><strong>检查并交付。</strong> 查看执行结果与验证证据，再完成代码合并。</li></ol></section><section class="panel"><h2>桌面执行，移动参与</h2><p class="lead">Mac 负责本地项目和运行环境。移动端通过 Cloud 与桌面端建立连接，查看工作进展并参与交互。</p><a href="/download">查看平台与安装说明 →</a></section></main>`);
}

export function renderDownloadPage(catalog: DownloadCatalog): string {
  const mac = catalog.macOS;
  const buttons = [mac.dmgURL ? `<a class="button primary" href="${escapeHtml(mac.dmgURL)}" rel="noopener noreferrer">下载 DMG</a>` : "", mac.pkgURL ? `<a class="button" href="${escapeHtml(mac.pkgURL)}" rel="noopener noreferrer">下载 PKG</a>` : ""].join("");
  return layout(`<main id="main" class="wrap"><section><p class="eyebrow">下载与安装</p><h1>为你的工作设备<br>准备 Corptie。</h1><p class="lead">桌面端运行本地工作，移动端连接桌面端。选择适合设备的版本，并查看安装要求。</p></section><section class="platforms" aria-label="平台下载"><article class="panel"><h2>macOS</h2><p class="tag">Apple Silicon · macOS 14 或更高版本</p>${buttons ? `<p>版本 ${escapeHtml(mac.version ?? "")}</p><div class="actions">${buttons}</div><p class="muted">安装包来自 GitHub Releases，点击后将前往官方发布资产。</p>` : '<p class="status">正式安装包暂未开放下载。</p>'}</article><article class="panel"><h2>iPhone 与 iPad</h2>${catalog.iOSURL ? `<p>通过发布页面查看设备兼容性与安装要求。</p><div class="actions"><a class="button" href="${escapeHtml(catalog.iOSURL)}" rel="noopener noreferrer">${new URL(catalog.iOSURL).hostname === "testflight.apple.com" ? "通过 TestFlight 安装" : "前往 App Store"}</a></div>` : '<p class="status">移动端下载入口待发布。</p>'}</article></section><section aria-labelledby="install-title"><h2 id="install-title">开始使用</h2><ol class="steps"><li>下载并安装对应平台的正式版本。</li><li>在 Mac 上准备项目，以及已经完成认证的 Provider 运行环境。</li><li>创建 Work 和 Task，由 Session 推进具体工作。</li><li>需要移动连接时，在桌面端与移动端登录同一 Corptie Cloud 账号。</li></ol>${catalog.notesURL ? `<p><a href="${escapeHtml(catalog.notesURL)}" rel="noopener noreferrer">查看版本发布说明 →</a></p>` : ""}</section></main>`);
}

export function renderAccountPage(): string {
  return layout(`<main id="main" class="wrap narrow" data-account-page><section><p class="eyebrow">Corptie Cloud</p><h1 class="account-title">我的账号</h1><p class="lead">查看账号资料与已登记设备。</p><noscript><p>此页需要 JavaScript 才能检查登录状态并加载你的账号资料。</p><a href="/auth/sign-in">前往登录</a></noscript><p class="status" data-account-status role="status" aria-live="polite">正在检查登录状态…</p><button type="button" data-retry hidden>重新加载账号</button></section><div data-profile hidden><section class="panel" aria-labelledby="profile-title"><h2 id="profile-title">基本资料</h2><dl><dt>姓名</dt><dd data-name></dd><dt>邮箱</dt><dd data-email></dd><dt>邮箱验证</dt><dd data-verified></dd><dt>注册时间</dt><dd data-created></dd></dl><div class="actions"><a href="/auth/recover">找回账号或重置密码</a><button type="button" data-sign-out disabled>退出登录</button></div></section><section aria-labelledby="devices-title"><h2 id="devices-title">已登记设备</h2><p class="muted">登记信息不代表设备当前在线。连接状态请以客户端为准。</p><p class="status" data-device-status role="status" aria-live="polite"></p><ul class="devices" data-devices></ul><button type="button" data-device-retry hidden>重新加载设备</button></section></div></main>`);
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
    title, description, body, styles: ["/assets/site.css"],
    scripts: account ? ["/assets/web-http.js", "/assets/account.js"] : [],
    ...(account ? { noIndex: true } : { canonicalURL: options.baseURL + path }),
    assetVersion: options.version, cacheControl: account ? "no-store" : cache
  });
  const responses = new Map<string, Response>([
    ["/", document("/", "项目、任务与执行", "Corptie 将项目、任务、Session、Agent 和 Git 工具连接在一起，形成从想法到交付的工作流程。", renderHomePage(options.publicRegistration))],
    ["/download", document("/download", "下载 Corptie", "查看 Corptie 的平台、系统要求、正式下载入口与安装说明。", renderDownloadPage(options.downloads))],
    ["/account", document("/account", "我的账号", "查看 Corptie Cloud 账号资料与已登记设备。", renderAccountPage(), true)],
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
