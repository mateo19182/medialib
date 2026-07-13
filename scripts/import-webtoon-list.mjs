#!/usr/bin/env node
import fs from "node:fs";

function usage() {
  console.error("Usage: node scripts/import-webtoon-list.mjs [--status=read|reading|want] saved-webtoons.html > /tmp/webtoon-import.sql");
  process.exit(1);
}

const args = process.argv.slice(2);
const statusArg = args.find((arg) => arg.startsWith("--status="));
const status = statusArg ? statusArg.slice("--status=".length) : "read";
if (!["read", "reading", "want"].includes(status)) usage();
const file = args.find((arg) => !arg.startsWith("--"));
const html = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
if (!html.trim()) usage();

function decode(s = "") {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = tag.match(new RegExp(`${escaped}\\s*=\\s*(['"])(.*?)\\1`, "i"));
  return m ? decode(m[2]).trim() : null;
}

function text(block, className) {
  const m = block.match(new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  return m ? decode(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

function normalize(s) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function q(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function canonical(href, titleNo) {
  const url = new URL(href);
  return `${url.origin}${url.pathname}?title_no=${titleNo}`;
}

const items = [];
for (const m of html.matchAll(/<li\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
  const block = m[1];
  const linkTag = block.match(/<a\b[^>]*class=["'][^"']*\blink\b[^"']*["'][^>]*>/i)?.[0] ?? "";
  const href = attr(linkTag, "href");
  const inputTag = block.match(/<input\b[^>]*\bdata-title-no=["'][^"']+["'][^>]*>/i)?.[0] ?? "";
  const titleNo = attr(inputTag, "data-title-no") ?? (href ? new URL(href).searchParams.get("title_no") : null);
  const title = text(block, "subj");
  if (!href || !titleNo || !title) continue;
  const imgTag = block.match(/<img\b[^>]*>/i)?.[0] ?? "";
  const imageWrap = block.match(/<div\b[^>]*class=["'][^"']*\bimage_wrap\b[^"']*["'][^>]*>/i)?.[0] ?? "";
  const author = text(block, "author") || "Unknown";
  const url = canonical(href, titleNo);
  items.push({
    title,
    normalizedTitle: normalize(title),
    sourceId: titleNo,
    sourceUrl: url,
    coverUrl: attr(imgTag, "src"),
    mediaFormat: (attr(inputTag, "data-webtoon-type") || "WEBTOON").toLowerCase(),
    description: `By ${author}`,
    notes: text(block, "update") || null,
    tags: attr(imageWrap, "data-title-unsuitable-for-children") === "true" ? "mature" : null,
    raw: {
      title,
      author,
      titleNo,
      url,
      coverUrl: attr(imgTag, "src"),
      webtoonType: attr(inputTag, "data-webtoon-type"),
      updateLabel: text(block, "update") || null,
      unsuitableForChildren: attr(imageWrap, "data-title-unsuitable-for-children") === "true",
    },
  });
}

const deduped = Array.from(new Map(items.map((item) => [item.sourceId, item])).values());

for (const item of deduped) {
  const sourceItemId = `(SELECT item_id FROM item_sources WHERE provider = 'webtoon' AND item_kind = 'webtoon' AND provider_id = ${q(item.sourceId)})`;
  const titleItemId = `(SELECT id FROM media_items WHERE kind = 'webtoon' AND normalized_title = ${q(item.normalizedTitle)} ORDER BY id LIMIT 1)`;
  const itemId = `COALESCE(${sourceItemId}, ${titleItemId})`;
  console.log(
    `INSERT INTO media_items (kind, title, normalized_title, cover_url, description, media_format, list_status, notes, tags)
SELECT 'webtoon', ${q(item.title)}, ${q(item.normalizedTitle)}, ${q(item.coverUrl)}, ${q(item.description)}, ${q(item.mediaFormat)}, ${q(status)}, ${q(item.notes)}, ${q(item.tags)}
WHERE ${sourceItemId} IS NULL AND ${titleItemId} IS NULL;`,
  );
  console.log(
    `UPDATE media_items SET
  title = ${q(item.title)},
  normalized_title = ${q(item.normalizedTitle)},
  cover_url = COALESCE(cover_url, ${q(item.coverUrl)}),
  description = COALESCE(description, ${q(item.description)}),
  media_format = COALESCE(media_format, ${q(item.mediaFormat)}),
  list_status = COALESCE(list_status, ${q(status)}),
  notes = COALESCE(notes, ${q(item.notes)}),
  tags = COALESCE(tags, ${q(item.tags)})
WHERE id = ${itemId};`,
  );
  console.log(
    `INSERT OR IGNORE INTO item_sources (item_kind, item_id, provider, provider_id, url, title, status, raw_json, saved_at, saved_via)
VALUES ('webtoon', ${itemId}, 'webtoon', ${q(item.sourceId)}, ${q(item.sourceUrl)}, ${q(item.title)}, 'ok', ${q(JSON.stringify(item.raw))}, datetime('now'), 'import');`,
  );
  console.log(
    `UPDATE item_sources SET
  url = ${q(item.sourceUrl)},
  item_id = ${itemId},
  title = ${q(item.title)},
  status = 'ok',
  raw_json = ${q(JSON.stringify(item.raw))},
  saved_at = COALESCE(saved_at, datetime('now')),
  saved_via = 'import'
WHERE provider = 'webtoon' AND item_kind = 'webtoon' AND provider_id = ${q(item.sourceId)};`,
  );
  console.log(
    `INSERT OR IGNORE INTO enrich_queue (item_kind, item_id)
VALUES ('webtoon', ${itemId});`,
  );
}
console.error(`Prepared ${deduped.length} WEBTOON items`);
