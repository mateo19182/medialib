#!/usr/bin/env node
import fs from "node:fs";
import zlib from "node:zlib";

function text(path) {
  const buf = fs.readFileSync(path);
  return path.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return m ? decode(m[1]).trim() : "";
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function rating(score) {
  return score ? Math.max(1, Math.min(5, Math.round(score / 2))) : null;
}

function parseAnime(xml) {
  return [...xml.matchAll(/<anime>([\s\S]*?)<\/anime>/g)].map((m) => {
    const block = m[1];
    const id = tag(block, "series_animedb_id");
    const score = numberOrNull(tag(block, "my_score"));
    return {
      kind: "anime",
      sourceId: id,
      sourceUrl: `https://myanimelist.net/anime/${id}`,
      title: tag(block, "series_title"),
      mediaFormat: tag(block, "series_type") || null,
      listStatus: tag(block, "my_status") || null,
      progressCurrent: numberOrNull(tag(block, "my_watched_episodes")),
      progressTotal: numberOrNull(tag(block, "series_episodes")),
      personalScore: score,
      rating: rating(score),
      notes: tag(block, "my_comments") || null,
      tags: tag(block, "my_tags") || null,
    };
  });
}

function parseManga(xml) {
  return [...xml.matchAll(/<manga>([\s\S]*?)<\/manga>/g)].map((m) => {
    const block = m[1];
    const id = tag(block, "manga_mangadb_id");
    const score = numberOrNull(tag(block, "my_score"));
    const readChapters = numberOrNull(tag(block, "my_read_chapters"));
    const chapters = numberOrNull(tag(block, "manga_chapters"));
    const readVolumes = numberOrNull(tag(block, "my_read_volumes"));
    const volumes = numberOrNull(tag(block, "manga_volumes"));
    return {
      kind: "manga",
      sourceId: id,
      sourceUrl: `https://myanimelist.net/manga/${id}`,
      title: tag(block, "manga_title"),
      mediaFormat: null,
      listStatus: tag(block, "my_status") || null,
      progressCurrent: readChapters ?? readVolumes,
      progressTotal: chapters ?? volumes,
      personalScore: score,
      rating: rating(score),
      notes: tag(block, "my_comments") || null,
      tags: tag(block, "my_tags") || null,
    };
  });
}

const items = process.argv.slice(2).flatMap((path) => {
  const xml = text(path);
  if (xml.includes("<anime>")) return parseAnime(xml);
  if (xml.includes("<manga>")) return parseManga(xml);
  throw new Error(`unrecognized MAL export: ${path}`);
}).filter((i) => i.sourceId && i.title);

const values = items.map((i) =>
  `(${q(i.kind)}, ${q(i.title)}, ${q(normalize(i.title))}, 'myanimelist', ${q(i.sourceId)}, ${q(i.sourceUrl)}, ${q(i.mediaFormat)}, ${q(i.listStatus)}, ${q(i.progressCurrent)}, ${q(i.progressTotal)}, ${q(i.personalScore)}, ${q(i.rating)}, ${q(i.notes)}, ${q(i.tags)})`,
);

const linkValues = items.map((i) =>
  `(${q(i.sourceUrl)}, 'myanimelist', ${q(i.kind)}, ${q(i.sourceId)}, ${q(i.kind)}, (SELECT id FROM media_items WHERE source = 'myanimelist' AND kind = ${q(i.kind)} AND source_id = ${q(i.sourceId)}), ${q(i.title)}, 'ok', ${q(JSON.stringify(i))}, 'import')`,
);

console.log("BEGIN TRANSACTION;");
if (values.length) {
  console.log(`INSERT OR IGNORE INTO media_items (kind, title, normalized_title, source, source_id, source_url, media_format, list_status, progress_current, progress_total, personal_score, rating, notes, tags) VALUES\n${values.join(",\n")};`);
  for (const i of items) {
    console.log(
      `UPDATE media_items SET title = ${q(i.title)}, normalized_title = ${q(normalize(i.title))}, source_url = ${q(i.sourceUrl)}, media_format = ${q(i.mediaFormat)}, list_status = ${q(i.listStatus)}, progress_current = ${q(i.progressCurrent)}, progress_total = ${q(i.progressTotal)}, personal_score = ${q(i.personalScore)}, rating = ${q(i.rating)}, notes = ${q(i.notes)}, tags = ${q(i.tags)} WHERE source = 'myanimelist' AND kind = ${q(i.kind)} AND source_id = ${q(i.sourceId)};`,
    );
  }
}
if (linkValues.length) {
  console.log(`INSERT OR IGNORE INTO links (url, source, source_kind, source_id, entity_type, entity_id, title, status, raw_json, saved_via) VALUES\n${linkValues.join(",\n")};`);
  for (const i of items) {
    console.log(
      `UPDATE links SET entity_type = ${q(i.kind)}, entity_id = (SELECT id FROM media_items WHERE source = 'myanimelist' AND kind = ${q(i.kind)} AND source_id = ${q(i.sourceId)}), title = ${q(i.title)}, status = 'ok', raw_json = ${q(JSON.stringify(i))}, saved_via = 'import' WHERE source = 'myanimelist' AND source_kind = ${q(i.kind)} AND source_id = ${q(i.sourceId)};`,
    );
  }
}
console.log("COMMIT;");
console.error(`Prepared ${items.length} MAL items`);
