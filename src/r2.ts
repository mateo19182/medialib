import type { Env } from "./types";

/**
 * Download an image and store it in R2 under `key`, returning the key on
 * success or null on any failure (caller keeps the original hotlink URL).
 */
export async function cacheImage(env: Env, url: string, key: string): Promise<string | null> {
  try {
    const hostname = new URL(url).hostname;
    const headers = hostname === "webtoon-phinf.pstatic.net"
      ? { referer: "https://www.webtoons.com/" }
      : undefined;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const contentType = r.headers.get("content-type") ?? "image/jpeg";
    await env.MEDIA.put(key, await r.arrayBuffer(), { httpMetadata: { contentType } });
    return key;
  } catch {
    return null;
  }
}
