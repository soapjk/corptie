import { handleDshRpcRequest } from "./dshRpcAdapter.mjs";
import { handleDshWebStatic, isDshWebStaticPath } from "./dshWebStatic.mjs";
import { handleSessionExport } from "./dshSessionExport.mjs";

export function handleDshHttpRequest({
  request, response, url, sessionApplicationService, store, listGatewaySessions,
  sendJson, readJson, createSession, sendSessionMessage,
  readStoredSessionConversation, readStoredSessionTimeline, now,
  rpcHandler = handleDshRpcRequest, staticHandler = handleDshWebStatic, staticPathMatches = isDshWebStaticPath
}) {
  // DSH Session log 下载（路径 A 第 1 层）：/api/session.export 是 HTTP 端点而非 JSON-RPC，
  // 前端先 HEAD 探活（要求 response.ok），再以 GET 触发浏览器下载 ZIP。
  // 必须在 /api/session.* 的 JSON-RPC 分发之前拦截，否则会落到 session.export 的
  // dispatch switch（未实现）而 404。文件名约定由前端 sessionLogZipFilename 决定，
  // 后端只负责返回有效 ZIP 字节。
  if (url.pathname === "/api/session.export") {
    handleSessionExport({ request, response, url, readStoredSessionConversation, readStoredSessionTimeline, now, sendJson });
    return true;
  }

  // DSH Session RPC 适配层（路径 A 第 1 层）：让 DSH web 前端渲染并驱动 Corptie 会话。
  // 接管 /api/session.*、/api/subagent.*，以及 boot 握手宿主级端点
  // host.describe / settings.describe / workspace.list，映射到 SessionApplicationService + store。
  // handleDshRpcRequest 是 async（需 readJson），用 then 链；route 本身保持同步。
  if (
    url.pathname.startsWith("/api/session.")
    || url.pathname.startsWith("/api/subagent.")
    || url.pathname === "/api/host.describe"
    || url.pathname === "/api/settings.describe"
    || url.pathname === "/api/settings.mutate"
    || url.pathname === "/api/workspace.list"
  ) {
    rpcHandler({
      request,
      response,
      url,
      sessionApplicationService,
      store,
      listStoredSessions: listGatewaySessions,
      sendJson,
      readJson,
      createSession,
      sendSessionMessage
    }).then((handled) => {
      if (!handled) {
        sendJson(response, 404, { error: "dsh rpc not handled" });
      }
    }).catch((error) => {
      console.error("[dsh-adapter] unhandled error:", error?.message ?? error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal error" });
      }
    });
    return true;
  }

  // DSH web 前端静态快照（路径 B2）：服务 DSH 的 React + Cordis 前端（脱离 DSH host），
  // 让 WKWebView 加载 Corptie backend 直接提供的 index.html + 插件 bundle + assets，
  // 而 /api/session.* 由上方 dshRpcAdapter 响应（同源，无需桥接）。
  // 只接管 GET/HEAD 的 /、/assets/*、/plugins/*、/manifest.webmanifest、/favicon.svg。
  if (staticPathMatches(request, url.pathname)) {
    staticHandler({ request, response, url }).catch((error) => {
      console.error("[dsh-web-static] unhandled error:", error?.message ?? error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal error" });
      }
    });
    return true;
  }

  return false;
}
