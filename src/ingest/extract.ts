import { htmlDecode } from "../util";

/**
 * Some sites (notably Spotify) only serve rich og:/JSON-LD metadata to
 * crawlers. Presenting a crawler UA gets us the same preview data their link
 * unfurls use.
 */
export const CRAWLER_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export async function fetchText(url: string, ua: string = CRAWLER_UA): Promise<string> {
  const r = await fetch(url, {
    headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml", "accept-language": "en" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return await r.text();
}

/**
 * Extract og:/twitter:/music: <meta> tags into a map. Handles either attribute
 * order (property-first or content-first) and decodes HTML entities.
 */
export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = tag.match(/(?:property|name)\s*=\s*"([^"]+)"/i)?.[1];
    const content = tag.match(/content\s*=\s*"([^"]*)"/i)?.[1];
    if (!key || content == null) continue;
    if (/^(og:|twitter:|music:)/.test(key) && !(key in out)) out[key] = htmlDecode(content);
  }
  return out;
}

/** Parse every <script type="application/ld+json"> block; ignore malformed ones. */
export function jsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
