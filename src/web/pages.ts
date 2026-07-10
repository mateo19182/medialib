import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { LibraryStats } from "../types";
import type { ArtistDetail, ArtistSummary, BookRow, RecentLink, SaveResult } from "../do/library";

function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <script src="https://unpkg.com/htmx.org@2.0.4"></script>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-50 text-slate-800 min-h-screen antialiased">
        <nav class="bg-slate-900 text-white sticky top-0 z-20">
          <div class="max-w-5xl mx-auto px-6 h-14 flex items-center gap-8">
            <a href="/" class="font-semibold tracking-tight flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>medialib
            </a>
            <div class="flex gap-5 text-sm text-slate-300">
              <a href="/library" class="hover:text-white">Music</a>
              <a href="/books" class="hover:text-white">Books</a>
              <a href="/add" class="hover:text-white">Add</a>
            </div>
          </div>
        </nav>
        <main class="max-w-5xl mx-auto px-6 py-8">${body}</main>
      </body>
    </html>`;
}

/** Prefer the R2-cached image; fall back to the source hotlink. */
function mediaSrc(key: string | null, url: string | null): string | null {
  return key ? `/media/${key}` : url;
}

function fmtDuration(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = Math.round(n / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const STAT_LABELS: [keyof LibraryStats, string][] = [
  ["tracks", "tracks"],
  ["artists", "artists"],
  ["albums", "albums"],
  ["books", "books"],
  ["links", "saved links"],
];

export function dashboard(stats: LibraryStats, recent: RecentLink[]) {
  const cards = STAT_LABELS.map(
    ([k, label]) => html`
      <div class="bg-white border border-slate-200 rounded-xl p-5">
        <div class="text-3xl font-bold tracking-tight">${stats[k]}</div>
        <div class="text-sm text-slate-500 mt-0.5">${label}</div>
      </div>
    `,
  );

  const rows = recent.length
    ? recent.map((r) => {
        const label = String(r.title || r.url);
        const badge = String(r.status) === "ok" ? "text-emerald-600" : String(r.status) === "error" ? "text-red-500" : "text-slate-400";
        return html`
          <a href="${String(r.url)}" target="_blank" rel="noopener" class="flex items-center justify-between gap-3 py-2 px-1 hover:bg-slate-50 rounded-lg">
            <span class="min-w-0 flex-1 truncate text-sm">${label}</span>
            <span class="text-xs whitespace-nowrap ${badge}">${String(r.source)} · ${String(r.status)}</span>
          </a>
        `;
      })
    : [html`<p class="text-sm text-slate-500">Nothing saved yet. Send a link to the bot or use <a class="underline" href="/add">Add</a>.</p>`];

  return layout(
    "medialib",
    html`
      <div class="mb-8">
        <h1 class="text-3xl font-bold tracking-tight">Your library</h1>
        <p class="text-slate-500 mt-1">Save music &amp; books by link — Spotify, YouTube, Bandcamp, Goodreads.</p>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-10">${cards}</div>
      <div class="bg-white border border-slate-200 rounded-xl p-5">
        <div class="flex items-center justify-between mb-2">
          <h2 class="font-semibold">Recently saved</h2>
          <a href="/add" class="text-sm text-emerald-600 hover:underline">+ Add link</a>
        </div>
        <div class="divide-y divide-slate-100">${rows}</div>
      </div>
    `,
  );
}

export function addPage(result?: SaveResult) {
  let banner: HtmlEscapedString | Promise<HtmlEscapedString> | string = "";
  if (result) {
    if (!result.ok) {
      banner = html`<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-5 text-sm">${result.error ?? "Could not save"}</div>`;
    } else if (result.duplicate) {
      banner = html`<div class="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg mb-5 text-sm">Already saved: <strong>${result.title}</strong></div>`;
    } else if (result.status === "ok") {
      banner = html`<div class="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg mb-5 text-sm">Saved <strong>${result.title}</strong> (${result.entityType}).</div>`;
    } else {
      banner = html`<div class="bg-slate-100 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg mb-5 text-sm">Saved the link, but metadata couldn't be fetched${result.error ? `: ${result.error}` : ""}.</div>`;
    }
  }
  return layout(
    "Add · medialib",
    html`
      <div class="max-w-xl">
        <h1 class="text-2xl font-bold tracking-tight mb-1">Add by link</h1>
        <p class="text-slate-500 text-sm mb-6">Paste a Spotify, YouTube, Bandcamp, or Goodreads link.</p>
        ${banner}
        <form method="post" action="/add" class="flex gap-2">
          <input name="url" type="url" required placeholder="https://open.spotify.com/track/..." autofocus
            class="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10" />
          <button class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Save</button>
        </form>
      </div>
    `,
  );
}

export function libraryPage(artists: ArtistSummary[]) {
  const body = artists.length
    ? html`<div class="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
        ${artists.map(
          (a) => html`
            <a href="/artist/${a.id}" class="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300">
              ${mediaSrc(a.image_key, a.image_url)
                ? html`<img src="${mediaSrc(a.image_key, a.image_url)}" alt="" class="w-12 h-12 rounded-full object-cover bg-slate-100" />`
                : html`<span class="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300">♪</span>`}
              <span class="min-w-0">
                <span class="block font-medium truncate">${a.name}</span>
                <span class="block text-xs text-slate-500">${a.tracks} tracks · ${a.albums} albums</span>
              </span>
            </a>
          `,
        )}
      </div>`
    : html`<p class="text-slate-500 text-sm">No music yet. <a class="underline" href="/add">Add a link</a>.</p>`;
  return layout("Music · medialib", html`<h1 class="text-2xl font-bold tracking-tight mb-6">Music</h1>${body}`);
}

const STATUS_LABEL: Record<string, string> = { want: "Want to read", reading: "Reading", read: "Read" };

export function booksPage(books: BookRow[]) {
  const body = books.length
    ? html`<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        ${books.map(
          (b) => html`
            <div class="bg-white border border-slate-200 rounded-xl p-3">
              ${mediaSrc(b.cover_key, b.cover_url)
                ? html`<img src="${mediaSrc(b.cover_key, b.cover_url)}" alt="" class="w-full aspect-[2/3] rounded-lg object-cover mb-2 bg-slate-100" />`
                : html`<div class="w-full aspect-[2/3] rounded-lg bg-slate-100 mb-2 flex items-center justify-center text-slate-300 text-2xl">📖</div>`}
              <div class="text-sm font-medium leading-tight line-clamp-2">${b.title}</div>
              ${b.author ? html`<div class="text-xs text-slate-500 truncate">${b.author}</div>` : ""}
              ${b.reading_status ? html`<div class="text-[11px] text-emerald-600 mt-1">${STATUS_LABEL[b.reading_status] ?? b.reading_status}</div>` : ""}
            </div>
          `,
        )}
      </div>`
    : html`<p class="text-slate-500 text-sm">No books yet. Send a Goodreads link to the bot or use <a class="underline" href="/add">Add</a>.</p>`;
  return layout("Books · medialib", html`<h1 class="text-2xl font-bold tracking-tight mb-6">Books</h1>${body}`);
}

export function artistPage(detail: ArtistDetail) {
  const { artist, albums, tracks } = detail;
  return layout(
    `${artist.name} · medialib`,
    html`
      <a href="/library" class="text-sm text-slate-500 hover:underline">← Music</a>
      <div class="flex items-center gap-4 mt-3 mb-8">
        ${mediaSrc(artist.image_key, artist.image_url)
          ? html`<img src="${mediaSrc(artist.image_key, artist.image_url)}" alt="" class="w-20 h-20 rounded-full object-cover bg-slate-100" />`
          : html`<span class="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center text-slate-300 text-2xl">♪</span>`}
        <div>
          <h1 class="text-2xl font-bold tracking-tight">${artist.name}</h1>
          ${artist.genres ? html`<p class="text-sm text-slate-500">${artist.genres}</p>` : ""}
        </div>
      </div>
      ${albums.length
        ? html`<h2 class="font-semibold mb-2">Albums</h2>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              ${albums.map(
                (al) => html`
                  <div class="bg-white border border-slate-200 rounded-xl p-3">
                    ${mediaSrc(al.cover_key, al.cover_url)
                      ? html`<img src="${mediaSrc(al.cover_key, al.cover_url)}" alt="" class="w-full aspect-square rounded-lg object-cover mb-2 bg-slate-100" />`
                      : html`<div class="w-full aspect-square rounded-lg bg-slate-100 mb-2"></div>`}
                    <div class="text-sm font-medium truncate">${String(al.title)}</div>
                    ${al.year ? html`<div class="text-xs text-slate-400">${String(al.year)}</div>` : ""}
                  </div>
                `,
              )}
            </div>`
        : ""}
      ${tracks.length
        ? html`<h2 class="font-semibold mb-2">Tracks</h2>
            <div class="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
              ${tracks.map(
                (t) => html`
                  <div class="flex items-center justify-between gap-3 px-4 py-2">
                    <span class="min-w-0"><span class="block text-sm truncate">${String(t.title)}</span>
                      ${t.album ? html`<span class="block text-xs text-slate-400 truncate">${String(t.album)}</span>` : ""}</span>
                    <span class="text-xs text-slate-400 tabular-nums">${fmtDuration(t.duration_ms)}</span>
                  </div>
                `,
              )}
            </div>`
        : ""}
    `,
  );
}
