import type { Classified, FetchedVisual } from "./types";
import { fetchText, metaTags } from "./extract";
import { htmlDecode } from "../util";

export interface WebtoonListItem {
  url: string;
  titleNo: string;
  title: string;
  author: string;
  coverUrl?: string;
  webtoonType?: string;
  updateLabel?: string;
  unsuitableForChildren?: boolean;
}

const attr = (tag: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = tag.match(new RegExp(`${escaped}\\s*=\\s*(['"])(.*?)\\1`, "i"));
  return m ? htmlDecode(m[2]).trim() : undefined;
};

const stripTags = (value: string): string => htmlDecode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const childText = (html: string, className: string): string | undefined => {
  const m = html.match(new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  const text = m ? stripTags(m[1]) : "";
  return text || undefined;
};

export function parseWebtoonSavedList(html: string): WebtoonListItem[] {
  const out: WebtoonListItem[] = [];
  for (const m of html.matchAll(/<li\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1];
    const linkTag = block.match(/<a\b[^>]*class=["'][^"']*\blink\b[^"']*["'][^>]*>/i)?.[0] ?? "";
    const href = attr(linkTag, "href");
    const inputTag = block.match(/<input\b[^>]*\bdata-title-no=["'][^"']+["'][^>]*>/i)?.[0] ?? "";
    const titleNo = attr(inputTag, "data-title-no") ?? (href ? new URL(href).searchParams.get("title_no") ?? undefined : undefined);
    const title = childText(block, "subj");
    const author = childText(block, "author") ?? "Unknown";
    if (!href || !titleNo || !title) continue;
    const imgTag = block.match(/<img\b[^>]*>/i)?.[0] ?? "";
    const imageWrap = block.match(/<div\b[^>]*class=["'][^"']*\bimage_wrap\b[^"']*["'][^>]*>/i)?.[0] ?? "";
    out.push({
      url: href,
      titleNo,
      title,
      author,
      coverUrl: attr(imgTag, "src"),
      webtoonType: attr(inputTag, "data-webtoon-type"),
      updateLabel: childText(block, "update"),
      unsuitableForChildren: attr(imageWrap, "data-title-unsuitable-for-children") === "true",
    });
  }
  return out;
}

function titleFromOg(raw: string): string {
  return htmlDecode(raw)
    .replace(/\s*\|\s*WEBTOON\s*$/i, "")
    .replace(/\s*-\s*WEBTOON\s*$/i, "")
    .trim();
}

export function parseWebtoonPage(og: Record<string, string>): FetchedVisual | null {
  const title = titleFromOg(og["og:title"] ?? og["twitter:title"] ?? "");
  if (!title) return null;
  return {
    kind: "webtoon",
    title,
    description: og["og:description"] || undefined,
    coverUrl: og["og:image"] || og["twitter:image"],
  };
}

export async function fetchWebtoon(c: Classified): Promise<FetchedVisual | null> {
  if (c.itemKind !== "webtoon") return null;
  const html = await fetchText(c.url);
  return parseWebtoonPage(metaTags(html));
}
