// dshWebStatic.mjs — 服务 DSH web 前端的静态快照（路径 B2）。
//
// 目标：让 DSH 的 React + Cordis 插件化前端脱离 DSH host，由 Corptie backend
// 直接服务其静态资源，而 /api/session.* 由 dshRpcAdapter.mjs 响应（同源，无需桥接）。
//
// 静态快照来源：从 DSH 项目 `dsh web` 生成的 `__DSH_BOOT__` + 预构建的插件 bundle
// （packages/*/lib/client.js）+ apps/web/dist，复制到本目录 `web-dist/` 下。
//
// 目录布局（web-dist/）：
//   index.html                 — 已注入 window.__DSH_BOOT__ 的入口
//   boot.json                  — __DSH_BOOT__ 的 JSON 快照（备查）
//   manifest.webmanifest       — PWA manifest
//   favicon.svg                — 图标
//   assets/                    — Vite 构建产物（shell bundle + vendor + fonts + langs）
//   plugins/<id>.js            — 每个声明 dsh.client.platform==='web' 的插件的 client bundle
//   plugins/<id>.js.map        — 对应 source map
//
// 路由约定（与 DSH host 的 ClientModuleRegistry.serveBundle 对齐）：
//   /                          → index.html
//   /assets/*                  → assets/*
//   /manifest.webmanifest      → manifest.webmanifest
//   /favicon.svg               → favicon.svg
//   /plugins/<id>/client.js        → plugins/<id>.js（<id> 是包名，可含 scope 斜杠）
//   /plugins/<id>/client.js.map    → plugins/<id>.js.map
//
// 注意：DSH 的 __DSH_BOOT__ entry.url 形如 "/plugins/@scope/name/client.js?rev=..."，
// 其中 <id> = "@scope/name"（含斜杠），所以路径是 /plugins/@scope/name/client.js。
// 我们存成 plugins/@scope/name.js（扁平成单文件），服务时把 "/plugins/<id>/client.js"
// 映射回 plugins/<id>.js。

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";

const webDistDir = fileURLToPath(new URL("./web-dist", import.meta.url));

// content-type 映射：覆盖 DSH 前端用到的所有资源类型。
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".ttf", "font/ttf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function contentTypeFor(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES.get(path.slice(dot).toLowerCase()) ?? "application/octet-stream";
}

// 把 URL 路径安全地解析到 web-dist 内的文件路径，越界返回 null。
function resolveStaticPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);

  // 根路径 → index.html
  if (decoded === "/" || decoded === "") return { file: "index.html", cache: "no-cache" };

  // /manifest.webmanifest
  if (decoded === "/manifest.webmanifest") return { file: "manifest.webmanifest", cache: "no-cache" };

  // /favicon.svg
  if (decoded === "/favicon.svg") return { file: "favicon.svg", cache: "no-cache" };

  // /assets/* → assets/*
  if (decoded.startsWith("/assets/")) {
    const rel = decoded.slice("/assets/".length);
    if (!rel) return null;
    return { file: `assets/${rel}`, cache: "immutable" };
  }

  // /plugins/<id>/client.js(.map)? → plugins/<id>.js(.map)?
  if (decoded.startsWith("/plugins/")) {
    const rest = decoded.slice("/plugins/".length);
    const mapMatch = rest.match(/^(.+)\/client\.js\.map$/);
    const bundleMatch = rest.match(/^(.+)\/client\.js$/);
    if (mapMatch) {
      return { file: `plugins/${mapMatch[1]}.js.map`, cache: "no-cache" };
    }
    if (bundleMatch) {
      return { file: `plugins/${bundleMatch[1]}.js`, cache: "no-cache" };
    }
    return null;
  }

  return null;
}

// 同步判断：该请求路径是否归本模块管（用于 route 里的快速短路，避免对所有请求都触发 async）。
export function isDshWebStaticPath(request, urlPathname) {
  return (request.method === "GET" || request.method === "HEAD") && resolveStaticPath(urlPathname) !== null;
}

// 读取并服务一个静态文件。返回 true 表示已处理（成功或 404），false 表示不归本模块管。
export async function handleDshWebStatic({ request, response, url }) {
  // 只处理 GET / HEAD。
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const resolved = resolveStaticPath(url.pathname);
  if (!resolved) return false;
  // 规范化路径，防目录穿越：拼接后必须仍在 webDistDir 内。
  const target = normalize(join(webDistDir, resolved.file));
  if (!target.startsWith(webDistDir + "/") && target !== join(webDistDir, "index.html")) {
    // 理论上 resolveStaticPath 已保证，这里兜底。
    return false;
  }

  let body;
  try {
    body = await readFile(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return true;
    }
    throw error;
  }

  const headers = {
    "content-type": contentTypeFor(target),
    "content-length": Buffer.byteLength(body)
  };
  if (resolved.cache === "immutable") {
    // Vite 构建产物带内容 hash，可长缓存。
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    // index.html / bundle / manifest 每次校验（bundle 可能随 DSH 更新变化）。
    headers["cache-control"] = "no-cache";
  }

  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

// 供测试/诊断：暴露 webDistDir 与静态路径解析（不引入运行时开销）。
export const _internal = { webDistDir, resolveStaticPath, contentTypeFor };