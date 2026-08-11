import { execFile } from "node:child_process";
import { promisify } from "node:util";

const DEFAULT_FEED_URL = "https://nitter.net/thsottiaux/rss";
const DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const STATE_KEY = "codex.reset-forecast";
const execFileAsync = promisify(execFile);

export class CodexResetForecastMonitor {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.feedUrl = options.feedUrl ?? process.env.CORPTIE_TIBO_RSS_URL ?? DEFAULT_FEED_URL;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.proxyUrl = normalizedProxyUrl(options.proxyUrl);
    this.readFeed = options.readFeed
      ?? (options.fetch ? (() => fetchFeed(options.fetch, this.feedUrl, this.requestTimeoutMs)) : null)
      ?? (() => readFeedWithCurl(this.feedUrl, this.requestTimeoutMs, this.proxyUrl));
    this.now = options.now ?? (() => new Date());
    this.timer = null;
    this.running = false;
    this.state = normalizeStoredState(this.store?.getRuntimeState?.(STATE_KEY));
  }

  start() {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    const now = this.now();
    const forecast = isForecastActive(this.state.forecast, now) ? this.state.forecast : null;
    return {
      forecast,
      checkedAt: this.state.checkedAt,
      sourceHealthy: this.state.sourceHealthy,
      sourceError: this.state.sourceError,
      sourceUrl: this.feedUrl
    };
  }

  async refresh() {
    if (this.running || typeof this.readFeed !== "function") return this.snapshot();
    this.running = true;
    const checkedAt = this.now().toISOString();
    try {
      const items = parseRssItems(await this.readFeed());
      const nextForecast = latestForecastFromItems(items, this.now());
      this.state = {
        forecast: nextForecast,
        checkedAt,
        sourceHealthy: true,
        sourceError: null
      };
      this.persist();
      return this.snapshot();
    } catch (error) {
      this.state = {
        ...this.state,
        checkedAt,
        sourceHealthy: false,
        sourceError: feedErrorMessage(error)
      };
      this.persist();
      console.warn(`[codex-reset-forecast] refresh failed: ${this.state.sourceError}`);
      return this.snapshot();
    } finally {
      this.running = false;
    }
  }

  persist() {
    this.store?.setRuntimeState?.(STATE_KEY, this.state);
  }
}

async function fetchFeed(fetchImplementation, feedUrl, requestTimeoutMs) {
  const response = await fetchImplementation(feedUrl, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      "user-agent": "Corptie Codex reset monitor/0.5"
    },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`RSS request failed with HTTP ${response.status}`);
  return response.text();
}

async function readFeedWithCurl(feedUrl, requestTimeoutMs, proxyUrl) {
  const args = curlArgumentsForFeed(feedUrl, requestTimeoutMs, proxyUrl);
  try {
    const { stdout } = await execFileAsync(process.env.CORPTIE_CURL_PATH || "/usr/bin/curl", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw new Error(feedErrorMessage(error));
  }
}

export function curlArgumentsForFeed(feedUrl, requestTimeoutMs, proxyUrl) {
  const maxSeconds = Math.max(1, Math.ceil(requestTimeoutMs / 1000));
  return [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--connect-timeout", String(Math.min(10, maxSeconds)),
    "--max-time", String(maxSeconds),
    "--user-agent", "Corptie Codex reset monitor/0.5",
    "--header", "Accept: application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
    ...(proxyUrl ? ["--proxy", proxyUrl] : []),
    feedUrl
  ];
}

export function latestForecastFromItems(items, now = new Date()) {
  const ordered = [...items].sort((left, right) => dateValue(right.publishedAt) - dateValue(left.publishedAt));
  for (const item of ordered) {
    const signal = classifyCodexResetPost(item, now);
    if (signal.kind === "future") return signal.forecast;
    if (signal.kind === "completed") return null;
  }
  return null;
}

export function classifyCodexResetPost(item, now = new Date()) {
  const text = normalizeText(item?.text);
  if (!text || isRepost(text) || !mentionsCodexLimits(text)) return { kind: "irrelevant" };

  const publishedAt = validDate(item?.publishedAt) ?? now;
  const timing = futureTiming(text, publishedAt);
  const futureIntent = /\b(will|we(?:'re| are) going to|going to|plan(?:ning)? to|intend(?:ing)? to|about to)\b[\s\S]{0,100}\breset\b/i.test(text)
    || /\breset\b[\s\S]{0,100}\b(in|within|later|tonight|tomorrow|soon)\b/i.test(text);

  if (futureIntent || timing) {
    const normalizedTiming = timing ?? {
      label: "预计即将重置",
      expiresAt: new Date(publishedAt.getTime() + 12 * 60 * 60 * 1000).toISOString()
    };
    return {
      kind: "future",
      forecast: {
        postId: String(item.id || item.link || publishedAt.toISOString()),
        text,
        url: item.link || null,
        publishedAt: publishedAt.toISOString(),
        estimateLabel: normalizedTiming.label,
        expiresAt: normalizedTiming.expiresAt
      }
    };
  }

  if (/\b(have|has|had|just|now|already)\b[\s\S]{0,60}\breset\b|\breset(?:s|ting)?\b[\s\S]{0,60}\b(complete|completed|done|pressed|applied)\b/i.test(text)) {
    return { kind: "completed" };
  }
  return { kind: "irrelevant" };
}

export function parseRssItems(xml = "") {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const body = match[1];
    const link = tagValue(body, "link");
    return {
      id: tagValue(body, "guid") || postIdFromUrl(link) || link,
      link,
      publishedAt: tagValue(body, "pubDate"),
      text: cleanFeedText(tagValue(body, "title") || tagValue(body, "description"))
    };
  });
}

function futureTiming(text, publishedAt) {
  const lower = text.toLowerCase();
  const duration = lower.match(/\b(?:in|within)\s+(?:the\s+)?next\s+(\d{1,2})\s+hours?\b/)
    ?? lower.match(/\b(?:in|within)\s+(\d{1,2})\s+hours?\b/);
  if (duration) {
    const hours = Math.max(1, Math.min(72, Number(duration[1])));
    return timing(`预计未来${hours}小时内`, publishedAt, hours + 2);
  }
  if (/\b(?:in|within)\s+(?:the\s+)?next\s+hour\b|\bin\s+an\s+hour\b/.test(lower)) {
    return timing("预计未来1小时内", publishedAt, 3);
  }
  if (/\b(?:in|within)\s+(?:a\s+)?few\s+hours\b/.test(lower)) {
    return timing("预计未来几小时内", publishedAt, 8);
  }
  if (/\b(?:in|within)\s+(?:the\s+)?next\s+24\s+hours\b/.test(lower)) {
    return timing("预计未来24小时内", publishedAt, 26);
  }
  if (/\bday after tomorrow\b/.test(lower)) return timing("预计后天", publishedAt, 72);
  if (/\btomorrow\b/.test(lower)) return timing("预计明天", publishedAt, 48);
  if (/\blater today\b|\btonight\b/.test(lower)) return timing("预计今天稍晚", publishedAt, 18);
  if (/\bsoon\b|\bshortly\b/.test(lower)) return timing("预计即将重置", publishedAt, 12);
  return null;
}

function timing(label, publishedAt, expiresAfterHours) {
  return {
    label,
    expiresAt: new Date(publishedAt.getTime() + expiresAfterHours * 60 * 60 * 1000).toISOString()
  };
}

function mentionsCodexLimits(text) {
  return /\bcodex\b/i.test(text)
    && /\b(reset|limits?|rate limits?|usage|quota)\b/i.test(text)
    && /\breset\b/i.test(text);
}

function isRepost(text) {
  return /^rt\s+(?:by\s+)?@/i.test(text) || /^reposted\s+by\b/i.test(text);
}

function isForecastActive(forecast, now) {
  if (!forecast?.expiresAt) return false;
  return dateValue(forecast.expiresAt) > now.getTime();
}

function normalizeStoredState(value) {
  return {
    forecast: value?.forecast ?? null,
    checkedAt: value?.checkedAt ?? null,
    sourceHealthy: value?.sourceHealthy ?? null,
    sourceError: value?.sourceError ?? null
  };
}

function normalizedProxyUrl(value) {
  const proxy = String(value ?? "").trim();
  return /^(https?|socks5h?):\/\//i.test(proxy) ? proxy : null;
}

function feedErrorMessage(error) {
  const stderr = String(error?.stderr ?? "").trim();
  if (stderr) return stderr.replace(/\s+/g, " ").slice(0, 500);
  const message = String(error?.message ?? error ?? "RSS request failed");
  const curlLine = message.split("\n").find((line) => /^curl:/i.test(line.trim()));
  return (curlLine || message.split("\n")[0]).trim().slice(0, 500);
}

function tagValue(body, name) {
  const match = String(body).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? unwrapCdata(match[1]).trim() : "";
}

function unwrapCdata(value) {
  return String(value).replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1");
}

function cleanFeedText(value) {
  return decodeEntities(String(value).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function postIdFromUrl(url) {
  return String(url).match(/\/status\/(\d+)/)?.[1] ?? "";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateValue(value) {
  return validDate(value)?.getTime() ?? 0;
}
