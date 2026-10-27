export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export function securityHeaders(contentType: string, cacheControl = "no-store"): HeadersInit {
  return {
    "cache-control": cacheControl,
    "content-type": contentType,
    "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

export function asset(body: string, contentType: string, cacheControl = "public, max-age=3600"): Response {
  return new Response(body, { headers: securityHeaders(contentType, cacheControl) });
}

export function renderDocument(options: {
  title: string; description: string; body: string; styles: readonly string[];
  scripts?: readonly string[]; canonicalURL?: string; noIndex?: boolean;
  cacheControl?: string; assetVersion?: string;
}): Response {
  const version = options.assetVersion ? `?v=${encodeURIComponent(options.assetVersion)}` : "";
  const canonical = options.canonicalURL ? `<link rel="canonical" href="${escapeHtml(options.canonicalURL)}"><meta property="og:url" content="${escapeHtml(options.canonicalURL)}">` : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(options.title)} · Corptie</title><meta name="description" content="${escapeHtml(options.description)}"><meta property="og:title" content="${escapeHtml(options.title)} · Corptie"><meta property="og:description" content="${escapeHtml(options.description)}"><meta property="og:type" content="website">${canonical}${options.noIndex ? '<meta name="robots" content="noindex, nofollow">' : ""}${options.styles.map(path => `<link rel="stylesheet" href="${escapeHtml(path + version)}">`).join("")}${(options.scripts ?? []).map(path => `<script src="${escapeHtml(path + version)}" defer></script>`).join("")}</head><body>${options.body}</body></html>`;
  return new Response(html, { headers: securityHeaders("text/html; charset=utf-8", options.cacheControl ?? "no-store") });
}
