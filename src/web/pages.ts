import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { LiveShow } from "../live-shows";
import type { LibraryStats } from "../types";
import type {
  AlbumDetail,
  AlbumRow,
  ArtistDetail,
  ArtistSummary,
  BookDetail,
  BookRow,
  MediaDetail,
  MediaRow,
  PageResult,
  SaveResult,
  SearchResult,
  TrackDetail,
  TrackRow,
  YouTubeMigrationStatus,
  YouTubeSyncPlaylist,
  YouTubeSyncRun,
} from "../db/library";
import type { VisualKind } from "../ingest/types";

export type MusicView = "artists" | "albums" | "tracks";

function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/htmx.min.js" defer></script>
      </head>
      <body class="bg-slate-50 text-slate-800 min-h-screen antialiased">
        <nav class="bg-slate-900 text-white sticky top-0 z-20">
          <div class="max-w-6xl mx-auto px-6 min-h-14 py-2 flex flex-wrap items-center gap-x-8 gap-y-2">
            <a href="/" class="font-semibold tracking-tight flex items-center gap-2 shrink-0">
              <span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>medialib
            </a>
            <div class="flex gap-5 text-sm text-slate-300 whitespace-nowrap">
              <a href="/library" class="hover:text-white">Music</a>
              <a href="/books" class="hover:text-white">Books</a>
              <a href="/movies" class="hover:text-white">Movies</a>
              <a href="/series" class="hover:text-white">Series</a>
              <a href="/anime" class="hover:text-white">Anime</a>
              <a href="/manga" class="hover:text-white">Manga</a>
              <a href="/webtoons" class="hover:text-white">Webtoons</a>
              <a href="/comics" class="hover:text-white">Comics</a>
              <a href="/live" class="hover:text-white">Live</a>
              <a href="/youtube-sync" class="hover:text-white">Sync</a>
              <a href="https://links.m19182.dev" target="_blank" rel="noopener noreferrer" class="hover:text-white">Links</a>
              <a href="/add" class="hover:text-white">Add</a>
            </div>
            <form action="/search" method="get" class="ml-auto flex min-w-48 flex-1 sm:flex-none sm:w-64">
              <input name="q" type="search" placeholder="Search library"
                class="w-full rounded-lg border border-white/10 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40" />
            </form>
          </div>
        </nav>
        <main class="max-w-6xl mx-auto px-6 py-8">${body}</main>
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

function mediaProgress(item: Pick<MediaRow, "progress_current" | "progress_total">): string {
  if (!item.progress_current && !item.progress_total) return "";
  if (item.progress_total) return `${item.progress_current ?? 0}/${item.progress_total}`;
  return String(item.progress_current ?? "");
}

export const ARTIST_TYPE_LABELS: Record<string, string> = {
  musician: "Musician",
  visual_artist: "Visual artist",
  filmmaker: "Filmmaker",
  writer: "Writer",
  performer: "Performer",
  other: "Other",
};

function artistTypeSelect(value = "musician", classes = "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white") {
  return html`<select name="artistType" class="${classes}">
    ${Object.entries(ARTIST_TYPE_LABELS).map(([key, label]) => html`<option value="${key}" ${value === key ? "selected" : ""}>${label}</option>`)}
  </select>`;
}

/** Interactive 1–5 star rating (clicking the current value clears it). */
export function stars(kind: "track" | "album" | "book" | "media", id: number, rating: number | null) {
  const r = rating ?? 0;
  return html`<span class="stars inline-flex gap-0.5">
    ${[1, 2, 3, 4, 5].map(
      (n) => html`<button
        hx-post="/${kind}/${id}/rating"
        hx-vals="${`{"value": ${n === r ? 0 : n}}`}"
        hx-target="closest .stars"
        hx-swap="outerHTML"
        class="leading-none ${n <= r ? "text-amber-500" : "text-slate-300"} hover:text-amber-400"
        aria-label="${n} stars"
      >★</button>`,
    )}
  </span>`;
}

function musicHref(view: MusicView) {
  return view === "artists" ? "/library" : `/library?view=${view}`;
}

function artistText(t: Pick<TrackRow, "artists" | "artist">): string {
  return t.artists || t.artist || "Unknown artist";
}

/** Favorite toggle for a track. */
export function favBtn(id: number, on: boolean) {
  return html`<button
    hx-post="/track/${id}/favorite"
    hx-target="this"
    hx-swap="outerHTML"
    class="leading-none ${on ? "text-rose-500" : "text-slate-300"} hover:text-rose-400"
    title="Favorite"
  >♥</button>`;
}

const STAT_LABELS: [keyof LibraryStats, string][] = [
  ["tracks", "tracks"],
  ["artists", "artists"],
  ["albums", "albums"],
  ["books", "books"],
  ["movies", "movies"],
  ["series", "series"],
  ["anime", "anime"],
  ["manga", "manga"],
  ["webtoons", "webtoons"],
  ["comics", "comics"],
];

export function dashboard(stats: LibraryStats) {
  const cards = STAT_LABELS.map(
    ([k, label]) => html`
      <div class="bg-white border border-slate-200 rounded-xl p-5">
        <div class="text-3xl font-bold tracking-tight">${stats[k]}</div>
        <div class="text-sm text-slate-500 mt-0.5">${label}</div>
      </div>
    `,
  );

  return layout(
    "medialib",
    html`
      <div class="mb-8">
        <h1 class="text-3xl font-bold tracking-tight">Your library</h1>
        <p class="text-slate-500 mt-1">Save music, books, anime, manga, webtoons, and comics by link.</p>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">${cards}</div>
      ${stats.pending > 0
        ? html`<p class="text-xs text-amber-600 mb-8">⏳ ${stats.pending} item${stats.pending === 1 ? "" : "s"} enriching in the background…</p>`
        : html`<div class="mb-8"></div>`}
      <a href="https://links.m19182.dev" target="_blank" rel="noopener noreferrer" class="inline-flex text-sm font-medium text-emerald-700 hover:underline">Open Linkwarden</a>
    `,
  );
}

export function migratePage(status: YouTubeMigrationStatus, connected: boolean, message = "") {
  const total = status.items_total || status.pending;
  const pct = total ? Math.round((status.items_done / total) * 100) : 0;
  return layout(
    "YouTube Music migration · medialib",
    html`
      <div class="max-w-3xl">
        <h1 class="text-2xl font-bold tracking-tight mb-1">YouTube Music migration</h1>
        <p class="text-slate-500 text-sm mb-6">Move saved tracks into a private YouTube Music playlist.</p>
        ${message ? html`<div class="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg mb-5 text-sm">${message}</div>` : ""}
        <div class="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div class="flex flex-wrap items-center gap-3">
            <span class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm ${connected ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}">
              Google ${connected ? "connected" : "not connected"}
            </span>
            <span class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm bg-slate-100 text-slate-700">Status: ${status.status}</span>
            <span class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm bg-slate-100 text-slate-700">Quota: ${status.quota_used}/9500</span>
          </div>
          <div>
            <div class="flex justify-between text-sm mb-1">
              <span>${status.items_done}/${total} processed</span>
              <span>${pct}%</span>
            </div>
            <div class="h-2 rounded bg-slate-100 overflow-hidden"><div class="h-full bg-emerald-500" style="width:${pct}%"></div></div>
          </div>
          <dl class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><dt class="text-slate-500">Added</dt><dd class="font-semibold">${status.added}</dd></div>
            <div><dt class="text-slate-500">Skipped</dt><dd class="font-semibold">${status.skipped}</dd></div>
            <div><dt class="text-slate-500">Failed</dt><dd class="font-semibold">${status.failed}</dd></div>
            <div><dt class="text-slate-500">Pending</dt><dd class="font-semibold">${status.pending}</dd></div>
          </dl>
          ${status.playlist_url ? html`<a href="${status.playlist_url}" target="_blank" rel="noopener noreferrer" class="inline-flex text-sm font-medium text-emerald-700 hover:underline">Open playlist</a>` : ""}
          ${status.message ? html`<p class="text-sm text-slate-500">${status.message}</p>` : ""}
          <div class="flex flex-wrap gap-2">
            <a href="/oauth/google/start" class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">${connected ? "Reconnect Google" : "Connect Google"}</a>
            <form method="post" action="/migrate/start"><button class="bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-emerald-600" ${connected ? "" : "disabled"}>Start migration</button></form>
            <form method="post" action="/migrate/run"><button class="border border-slate-200 px-4 py-2 rounded-lg text-sm hover:bg-slate-50" ${connected ? "" : "disabled"}>Run batch now</button></form>
          </div>
        </div>
      </div>
    `,
  );
}

export function youtubeSyncPage(playlists: YouTubeSyncPlaylist[], run: YouTubeSyncRun | null, connected: boolean, message = "") {
  return layout(
    "YouTube sync · medialib",
    html`
      <div class="max-w-5xl">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 class="text-2xl font-bold tracking-tight mb-1">YouTube source sync</h1>
            <p class="text-slate-500 text-sm">Import new music from configured YouTube Music playlists.</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <a href="/oauth/google/start?next=/youtube-sync" class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">${connected ? "Reconnect Google" : "Connect Google"}</a>
            <form method="post" action="/youtube-sync/run"><button class="bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-emerald-600" ${connected ? "" : "disabled"}>Sync all</button></form>
          </div>
        </div>
        ${message ? html`<div class="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg mb-5 text-sm">${message}</div>` : ""}
        ${run ? html`
          <div class="bg-white border border-slate-200 rounded-xl p-5 mb-5">
            <div class="flex flex-wrap items-center gap-3 text-sm">
              <span class="inline-flex items-center rounded-lg px-3 py-1.5 bg-slate-100 text-slate-700">Last run: ${run.status}</span>
              <span class="text-slate-500">${run.playlists_done}/${run.playlists_total} playlists</span>
              <span class="text-slate-500">${run.pages_fetched} pages</span>
              <span class="text-slate-500">${run.imported} imported</span>
              <span class="text-slate-500">${run.duplicates} known</span>
              ${run.failed ? html`<span class="text-red-600">${run.failed} failed</span>` : ""}
            </div>
            ${run.message ? html`<p class="text-sm text-slate-500 mt-3">${run.message}</p>` : ""}
          </div>
        ` : ""}
        <form method="post" action="/youtube-sync/playlists" class="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <h2 class="font-semibold mb-3">Add playlist</h2>
          <div class="grid gap-3 md:grid-cols-[1.5fr_1fr_8rem_8rem_auto]">
            <input name="playlist" required placeholder="Playlist URL or ID" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <input name="title" placeholder="Label" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <input name="scanLimit" type="number" min="1" max="50" value="3" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <input name="stopAfterKnown" type="number" min="1" max="200" value="25" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <button class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Add</button>
          </div>
        </form>
        <div class="space-y-3">
          ${playlists.length ? playlists.map((playlist) => html`
            <div class="bg-white border border-slate-200 rounded-xl p-5">
              <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <a href="${playlist.url}" target="_blank" rel="noopener noreferrer" class="font-semibold text-emerald-700 hover:underline">${playlist.title}</a>
                  <div class="text-xs text-slate-500 mt-1">${playlist.playlist_id}</div>
                  <div class="text-xs mt-1 ${playlist.last_error ? "text-red-600" : "text-slate-500"}">
                    ${playlist.last_error ? playlist.last_error : playlist.last_sync_at ? `Last sync ${playlist.last_sync_at}` : "Not synced yet"}
                  </div>
                </div>
                <form method="post" action="/youtube-sync/run?playlist=${playlist.id}">
                  <button class="border border-slate-200 px-3 py-2 rounded-lg text-sm hover:bg-slate-50" ${connected && playlist.enabled ? "" : "disabled"}>Sync</button>
                </form>
              </div>
              <form method="post" action="/youtube-sync/playlists/${playlist.id}" class="grid gap-3 md:grid-cols-[1fr_7rem_7rem_7rem_auto_auto]">
                <input name="title" value="${playlist.title}" required class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                <label class="inline-flex items-center justify-center gap-2 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                  <input name="enabled" type="checkbox" value="1" ${playlist.enabled ? "checked" : ""} /> Enabled
                </label>
                <input name="scanLimit" type="number" min="1" max="50" value="${playlist.scan_limit}" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                <input name="stopAfterKnown" type="number" min="1" max="200" value="${playlist.stop_after_known}" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                <button class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Save</button>
                <button form="delete-youtube-playlist-${playlist.id}" class="border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm hover:bg-red-50">Delete</button>
              </form>
              <form id="delete-youtube-playlist-${playlist.id}" method="post" action="/youtube-sync/playlists/${playlist.id}/delete"></form>
            </div>
          `) : html`<div class="bg-white border border-slate-200 rounded-xl p-5 text-sm text-slate-500">No playlists configured.</div>`}
        </div>
      </div>
    `,
  );
}

function pager(page: PageResult<unknown>, path: string) {
  if (page.total <= page.limit) return "";
  const current = Math.floor(page.offset / page.limit) + 1;
  const pages = Math.ceil(page.total / page.limit);
  const separator = path.includes("?") ? "&" : "?";
  return html`<nav class="mt-6 flex items-center justify-between text-sm" aria-label="Pagination">
    ${current > 1 ? html`<a class="text-emerald-700 hover:underline" href="${path}${separator}page=${current - 1}">Previous</a>` : html`<span></span>`}
    <span class="text-slate-500">Page ${current} of ${pages} · ${page.total} items</span>
    ${current < pages ? html`<a class="text-emerald-700 hover:underline" href="${path}${separator}page=${current + 1}">Next</a>` : html`<span></span>`}
  </nav>`;
}

export function addPage(result?: SaveResult) {
  let banner: HtmlEscapedString | Promise<HtmlEscapedString> | string = "";
  if (result) {
    if (!result.ok) {
      banner = html`<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-5 text-sm">${result.error ?? "Could not save"}</div>`;
    } else if (result.duplicate) {
      banner = html`<div class="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg mb-5 text-sm">Already saved: <strong>${result.title}</strong></div>`;
    } else if (result.status === "ok") {
      banner = html`<div class="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg mb-5 text-sm">Saved <strong>${result.title}</strong> (${result.itemKind ?? "link"}).</div>`;
    } else {
      banner = html`<div class="bg-slate-100 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg mb-5 text-sm">Saved the link, but metadata couldn't be fetched${result.error ? `: ${result.error}` : ""}.</div>`;
    }
  }
  return layout(
    "Add · medialib",
    html`
      <div class="max-w-xl">
        <div class="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 class="text-2xl font-bold tracking-tight mb-1">Add to your library</h1>
            <p class="text-slate-500 text-sm">Choose a type, enter its title, then add it.</p>
          </div>
          <a href="/live/add" class="shrink-0 border border-emerald-700 px-3 py-2 rounded-lg text-sm font-medium text-emerald-700 hover:bg-emerald-50">Add live show</a>
        </div>
        ${banner}
        <form method="post" action="/add" class="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div class="grid sm:grid-cols-[10rem_1fr] gap-3">
            <select name="kind" required class="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="artist">Artist</option><option value="album">Album</option><option value="track">Track</option>
              <option value="book">Book</option><option value="movie">Movie</option><option value="series">Series</option>
              <option value="anime">Anime</option><option value="manga">Manga</option>
              <option value="webtoon">Webtoon</option><option value="comic">Comic</option>
            </select>
            <input name="title" required placeholder="Title or name" autofocus
              class="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10" />
          </div>
          <input name="creator" placeholder="Artist or author (optional; useful for albums, tracks, and books)"
            class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10" />
          ${artistTypeSelect()}
          <button class="w-full bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Find and add</button>
          <p class="text-xs text-slate-500">We'll search the best available catalogue first, then save your entry even when no match is found.</p>
        </form>
        <div class="flex items-center gap-3 my-6 text-xs text-slate-400"><span class="h-px bg-slate-200 flex-1"></span>or add by link<span class="h-px bg-slate-200 flex-1"></span></div>
        <form method="post" action="/add" class="flex gap-2">
          <input name="url" type="url" required placeholder="https://open.spotify.com/track/..."
            class="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10" />
          <button class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Save</button>
        </form>
      </div>
    `,
  );
}

export interface EditField { name: string; label: string; value?: string | number | null; type?: "text" | "number" | "date" | "select"; options?: Record<string, string>; multiline?: boolean; hint?: string; required?: boolean; }

export function editEntryPage(title: string, back: string, action: string, fields: EditField[], deleteAction?: string) {
  return layout(
    `Edit ${title} · medialib`,
    html`<div class="max-w-2xl"><a href="${back}" class="text-sm text-slate-500 hover:underline">← Cancel</a>
      <h1 class="text-2xl font-bold tracking-tight mt-3 mb-6">Edit ${title}</h1>
      <form method="post" action="${action}" class="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        ${fields.map((field) => html`<label class="block text-sm font-medium text-slate-700">${field.label}
          ${field.multiline
            ? html`<textarea name="${field.name}" rows="4" class="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">${field.value ?? ""}</textarea>`
            : field.type === "select"
              ? html`<select name="${field.name}" class="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white">
                  ${Object.entries(field.options ?? {}).map(([key, label]) => html`<option value="${key}" ${field.value === key ? "selected" : ""}>${label}</option>`)}
                </select>`
            : html`<input name="${field.name}" type="${field.type ?? "text"}" value="${field.value ?? ""}" ${field.required ? "required" : ""} class="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />`}
          ${field.hint ? html`<span class="block mt-1 text-xs font-normal text-slate-500">${field.hint}</span>` : ""}
        </label>`)}
        <button class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Save changes</button>
      </form>
      ${deleteAction ? html`<form method="post" action="${deleteAction}" class="mt-5" onsubmit="return confirm('Delete this entry? This cannot be undone.')">
        <button class="text-sm text-red-600 hover:underline">Delete ${title}</button>
      </form>` : ""}
    </div>`,
  );
}

function musicTabs(view: MusicView) {
  const tab = (key: MusicView, label: string) =>
    html`<a href="${musicHref(key)}"
      class="px-3 py-1.5 rounded-lg text-sm ${view === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}">${label}</a>`;
  return html`<div class="flex items-center gap-2 mb-6">${tab("artists", "Artists")}${tab("tracks", "Tracks")}${tab("albums", "Albums")}</div>`;
}

function trackRows(tracks: TrackRow[]) {
  return html`<div class="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
    ${tracks.map(
      (t) => html`
        <div class="grid grid-cols-[1fr_auto] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] items-center gap-3 px-4 py-2.5">
          <span class="min-w-0">
            <a href="/track/${t.id}" class="block text-sm font-medium truncate hover:underline">${t.title}</a>
            <span class="block md:hidden text-xs text-slate-400 truncate">${artistText(t)}${t.album ? ` · ${t.album}` : ""}</span>
          </span>
          <span class="hidden md:block min-w-0 text-sm text-slate-600 truncate">${artistText(t)}</span>
          <span class="hidden md:block min-w-0 text-xs text-slate-400 truncate">${t.album ?? ""}</span>
          <span class="flex items-center gap-3 shrink-0">
            ${stars("track", t.id, t.rating)}
            ${favBtn(t.id, !!t.favorite)}
            <span class="text-xs text-slate-400 tabular-nums w-9 text-right">${fmtDuration(t.duration_ms)}</span>
          </span>
        </div>
      `,
    )}
  </div>`;
}

function albumGrid(albums: AlbumRow[]) {
  return html`<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
    ${albums.map(
      (al) => html`
        <div class="bg-white border border-slate-200 rounded-xl p-3">
          <a href="/album/${al.id}" class="block">
            ${mediaSrc(al.cover_key, al.cover_url)
              ? html`<img loading="lazy" decoding="async" src="${mediaSrc(al.cover_key, al.cover_url)}" alt="" class="w-full aspect-square rounded-lg object-cover mb-2 bg-slate-100" />`
              : html`<div class="w-full aspect-square rounded-lg bg-slate-100 mb-2 flex items-center justify-center text-slate-300 text-2xl">♪</div>`}
            <div class="text-sm font-medium truncate">${al.title}</div>
          </a>
          ${al.artist_id && al.artist ? html`<a href="/artist/${al.artist_id}" class="block text-xs text-slate-500 truncate hover:underline">${al.artist}</a>` : ""}
          <div class="flex items-center justify-between mt-1 gap-2">
            <span class="text-xs text-slate-400">${[al.year, al.tracks ? `${al.tracks} tracks` : ""].filter(Boolean).join(" · ")}</span>
            ${stars("album", al.id, al.rating)}
          </div>
        </div>
      `,
    )}
  </div>`;
}

export function libraryPage(view: MusicView, data: PageResult<ArtistSummary | AlbumRow | TrackRow>) {
  let body: HtmlEscapedString | Promise<HtmlEscapedString>;
  if (view === "tracks") {
    const tracks = data.items as TrackRow[];
    body = tracks.length ? trackRows(tracks) : html`<p class="text-slate-500 text-sm">No tracks yet. <a class="underline" href="/add">Add a link</a>.</p>`;
  } else if (view === "albums") {
    const albums = data.items as AlbumRow[];
    body = albums.length ? albumGrid(albums) : html`<p class="text-slate-500 text-sm">No albums yet. <a class="underline" href="/add">Add a link</a>.</p>`;
  } else {
    const artists = data.items as ArtistSummary[];
    body = artists.length
    ? html`<div class="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
        ${artists.map(
          (a) => html`
            <a href="/artist/${a.id}" class="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300">
              ${mediaSrc(a.image_key, a.image_url)
                ? html`<img loading="lazy" decoding="async" src="${mediaSrc(a.image_key, a.image_url)}" alt="" class="w-12 h-12 rounded-full object-cover bg-slate-100" />`
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
  }
  return layout(
    "Music · medialib",
    html`<div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
        <div>
          <h1 class="text-2xl font-bold tracking-tight">Music</h1>
          <p class="text-sm text-slate-500 mt-1">Browse by artist, track, or album.</p>
        </div>
      </div>
      ${musicTabs(view)}
      ${body}${pager(data, musicHref(view))}`,
  );
}

const STATUS_LABEL: Record<string, string> = { want: "Want to read", reading: "Reading", read: "Read" };

export function booksPage(page: PageResult<BookRow>) {
  const books = page.items;
  const body = books.length
    ? html`<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        ${books.map(
          (b) => html`
            <a href="/book/${b.id}" class="block bg-white border border-slate-200 rounded-xl p-3 hover:border-slate-300">
              ${mediaSrc(b.cover_key, b.cover_url)
                ? html`<img loading="lazy" decoding="async" src="${mediaSrc(b.cover_key, b.cover_url)}" alt="" class="w-full aspect-[2/3] rounded-lg object-cover mb-2 bg-slate-100" />`
                : html`<div class="w-full aspect-[2/3] rounded-lg bg-slate-100 mb-2 flex items-center justify-center text-slate-300 text-2xl">📖</div>`}
              <div class="text-sm font-medium leading-tight line-clamp-2">${b.title}</div>
              ${b.author ? html`<div class="text-xs text-slate-500 truncate">${b.author}</div>` : ""}
              ${b.reading_status ? html`<div class="text-[11px] text-emerald-600 mt-1">${STATUS_LABEL[b.reading_status] ?? b.reading_status}</div>` : ""}
            </a>
          `,
        )}
      </div>`
    : html`<p class="text-slate-500 text-sm">No books yet. Send a Goodreads link to the bot or use <a class="underline" href="/add">Add</a>.</p>`;
  return layout("Books · medialib", html`<h1 class="text-2xl font-bold tracking-tight mb-6">Books</h1>${body}${pager(page, "/books")}`);
}

const MEDIA_LABELS: Record<VisualKind, { title: string; empty: string; fallback: string }> = {
  movie: { title: "Movies", empty: "No movies yet.", fallback: "🎬" },
  series: { title: "Series", empty: "No series yet.", fallback: "▣" },
  anime: { title: "Anime", empty: "No anime yet. Add a MyAnimeList anime link.", fallback: "◉" },
  manga: { title: "Manga", empty: "No manga yet. Add a MyAnimeList manga link.", fallback: "▤" },
  webtoon: { title: "Webtoons", empty: "No webtoons yet. Add a WEBTOON link or import your saved-list HTML.", fallback: "WT" },
  comic: { title: "Comics", empty: "No comics yet.", fallback: "CM" },
};

export function mediaListPage(kind: VisualKind, page: PageResult<MediaRow>) {
  const items = page.items;
  const label = MEDIA_LABELS[kind];
  const body = items.length
    ? html`<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
        ${items.map(
          (m) => html`
            <a href="/item/${m.id}" class="block bg-white border border-slate-200 rounded-xl p-3 hover:border-slate-300">
              ${mediaSrc(m.cover_key, m.cover_url)
                ? html`<img loading="lazy" decoding="async" src="${mediaSrc(m.cover_key, m.cover_url)}" alt="" class="w-full aspect-[2/3] rounded-lg object-cover mb-2 bg-slate-100" />`
                : html`<div class="w-full aspect-[2/3] rounded-lg bg-slate-100 mb-2 flex items-center justify-center text-slate-300 text-2xl">${label.fallback}</div>`}
              <div class="text-sm font-medium leading-tight line-clamp-2">${m.title}</div>
              <div class="flex items-center justify-between mt-1 gap-2">
                ${m.year ? html`<span class="text-xs text-slate-400">${m.year}</span>` : html`<span></span>`}
                ${stars("media", m.id, m.rating)}
              </div>
              ${m.list_status || mediaProgress(m)
                ? html`<div class="text-[11px] text-slate-500 mt-1 truncate">${[m.list_status, mediaProgress(m)].filter(Boolean).join(" · ")}</div>`
                : ""}
            </a>
          `,
        )}
      </div>`
    : html`<p class="text-slate-500 text-sm">${label.empty} <a class="underline" href="/add">Add a link</a>.</p>`;
  const path = kind === "movie" ? "/movies" : kind === "series" ? "/series" : kind === "webtoon" ? "/webtoons" : kind === "comic" ? "/comics" : `/${kind}`;
  return layout(`${label.title} · medialib`, html`<h1 class="text-2xl font-bold tracking-tight mb-6">${label.title}</h1>${body}${pager(page, path)}`);
}

export function mediaItemPage(item: MediaDetail) {
  const cover = mediaSrc(item.cover_key, item.cover_url);
  const label = MEDIA_LABELS[item.kind];
  const meta = [item.kind, item.media_format, item.year].filter(Boolean).join(" · ");
  const listMeta = [item.list_status, mediaProgress(item), item.personal_score ? `${item.personal_score}/10` : ""].filter(Boolean).join(" · ");
  return layout(
    `${item.title} · medialib`,
    html`
      <a href="/${item.kind === "movie" ? "movies" : item.kind === "webtoon" ? "webtoons" : item.kind === "comic" ? "comics" : item.kind}" class="text-sm text-slate-500 hover:underline">← ${label.title}</a>
      <div class="flex flex-col sm:flex-row gap-6 mt-3">
        <div class="shrink-0 w-40">
          ${cover
            ? html`<img loading="lazy" decoding="async" src="${cover}" alt="" class="w-40 rounded-xl object-cover bg-slate-100" />`
            : html`<div class="w-40 aspect-[2/3] rounded-xl bg-slate-100 flex items-center justify-center text-slate-300 text-3xl">${label.fallback}</div>`}
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-bold tracking-tight">${item.title}</h1>
          <a href="/edit/media/${item.id}" class="inline-block mt-2 text-sm text-emerald-700 hover:underline">Edit</a>
          ${meta ? html`<p class="text-sm text-slate-500 mt-1">${meta}</p>` : ""}
          ${listMeta ? html`<p class="text-sm text-emerald-700 mt-1">${listMeta}</p>` : ""}
          <div class="flex items-center gap-3 mt-4">
            <span class="text-sm text-slate-600 flex items-center gap-2">Rating ${stars("media", item.id, item.rating)}</span>
            ${item.provider_url ? html`<a href="${item.provider_url}" target="_blank" rel="noopener" class="text-sm text-emerald-600 hover:underline">${item.provider ?? "source"}</a>` : ""}
          </div>
          ${item.description ? html`<p class="text-sm text-slate-600 mt-5 leading-relaxed">${item.description}</p>` : ""}
          ${item.notes ? html`<p class="text-sm text-slate-600 mt-5 leading-relaxed">${item.notes}</p>` : ""}
          ${item.tags ? html`<p class="text-xs text-slate-400 mt-4">${item.tags}</p>` : ""}
        </div>
      </div>
    `,
  );
}

function liveYear(show: LiveShow): string {
  return show.date ? show.date.slice(0, 4) : "Date not noted";
}

export function liveShowsPage(shows: LiveShow[], artistLinks = new Map<string, { id: number; name: string }>()) {
  const venues = new Set(shows.map((show) => show.venue)).size;
  const dated = shows.filter((show) => show.date);
  const latest = dated[0];
  const years = Array.from(new Set(dated.map(liveYear))).sort((a, b) => Number(b) - Number(a));
  const grouped = years.map((year) => ({ year, shows: shows.filter((show) => liveYear(show) === year) }));
  const undated = shows.filter((show) => !show.date);
  if (undated.length) grouped.push({ year: "Date not noted", shows: undated });

  return layout(
    "Live shows · medialib",
    html`
      <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 class="text-2xl font-bold tracking-tight">Live shows</h1>
          <p class="text-sm text-slate-500 mt-1">Concert notes, festival sets, rooms, sound, and highlights.</p>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center text-sm">
          <div class="bg-white border border-slate-200 rounded-xl px-4 py-3">
            <div class="font-semibold text-slate-900">${shows.length}</div>
            <div class="text-xs text-slate-500">shows</div>
          </div>
          <div class="bg-white border border-slate-200 rounded-xl px-4 py-3">
            <div class="font-semibold text-slate-900">${venues}</div>
            <div class="text-xs text-slate-500">venues</div>
          </div>
          <div class="bg-white border border-slate-200 rounded-xl px-4 py-3">
            <div class="font-semibold text-slate-900">${latest?.dateLabel ?? "-"}</div>
            <div class="text-xs text-slate-500">latest</div>
          </div>
        </div>
      </div>

      <div class="space-y-8">
        ${grouped.map(
          (group) => html`
            <section>
              <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-400 mb-3">${group.year}</h2>
              <div class="space-y-3">
                ${group.shows.map((show) => {
                  const meta = [show.dateLabel, show.venue, show.city].filter(Boolean).join(" · ");
                  const artist = artistLinks.get(show.slug);
                  return html`
                    <article id="${show.slug}" class="bg-white border border-slate-200 rounded-xl p-5">
                      <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                        <div class="min-w-0">
                          <h3 class="text-lg font-semibold tracking-tight text-slate-900">${artist ? html`<a href="/artist/${artist.id}" class="hover:underline">${show.artist}</a>` : show.artist}</h3>
                          <p class="text-sm text-slate-500 mt-0.5">${meta}</p>
                          <a href="/live/${show.slug}/edit" class="inline-block mt-2 text-xs text-emerald-700 hover:underline">Edit show</a>
                          ${show.context || show.companions
                            ? html`<p class="text-xs text-slate-400 mt-1">${[show.context, show.companions ? `with ${show.companions}` : ""].filter(Boolean).join(" · ")}</p>`
                            : ""}
                        </div>
                        <div class="flex flex-wrap gap-1.5 md:justify-end">
                          ${show.tags.map((tag) => html`<span class="text-[11px] rounded-full bg-slate-100 px-2 py-1 text-slate-500">${tag}</span>`)}
                        </div>
                      </div>
                      <p class="text-sm text-slate-700 leading-relaxed mt-4">${show.summary}</p>
                      <ul class="mt-4 space-y-1.5 text-sm text-slate-600">
                        ${show.notes.map((note) => html`<li class="flex gap-2"><span class="text-slate-300">-</span><span>${note}</span></li>`)}
                      </ul>
                    </article>
                  `;
                })}
              </div>
            </section>
          `,
        )}
      </div>
    `,
  );
}

export function bookPage(b: BookDetail) {
  const cover = mediaSrc(b.cover_key, b.cover_url);
  const statusOpt = (v: string, label: string) =>
    html`<option value="${v}" ${b.reading_status === v ? "selected" : ""}>${label}</option>`;
  const meta = [b.author, b.year, b.page_count ? `${b.page_count} pp` : null, b.publisher]
    .filter(Boolean)
    .join(" · ");
  return layout(
    `${b.title} · medialib`,
    html`
      <a href="/books" class="text-sm text-slate-500 hover:underline">← Books</a>
      <div class="flex flex-col sm:flex-row gap-6 mt-3">
        <div class="shrink-0 w-40">
          ${cover
            ? html`<img loading="lazy" decoding="async" src="${cover}" alt="" class="w-40 rounded-xl object-cover bg-slate-100" />`
            : html`<div class="w-40 aspect-[2/3] rounded-xl bg-slate-100 flex items-center justify-center text-slate-300 text-3xl">📖</div>`}
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-bold tracking-tight">${b.title}</h1>
          <a href="/edit/book/${b.id}" class="inline-block mt-2 text-sm text-emerald-700 hover:underline">Edit</a>
          ${meta ? html`<p class="text-sm text-slate-500 mt-1">${meta}</p>` : ""}
          <div class="flex items-center gap-4 mt-4">
            <label class="text-sm text-slate-600">Status
              <select name="status" hx-post="/book/${b.id}/status" hx-trigger="change" hx-swap="none"
                class="ml-2 border border-slate-200 rounded-lg px-2 py-1 text-sm">
                ${statusOpt("want", "Want to read")}${statusOpt("reading", "Reading")}${statusOpt("read", "Read")}
              </select>
            </label>
            <span class="text-sm text-slate-600 flex items-center gap-2">Rating ${stars("book", b.id, b.rating)}</span>
          </div>
          ${b.description ? html`<p class="text-sm text-slate-600 mt-5 leading-relaxed">${b.description}</p>` : ""}
          ${b.isbn ? html`<p class="text-xs text-slate-400 mt-4">ISBN ${b.isbn}</p>` : ""}
        </div>
      </div>
    `,
  );
}

export function albumPage(detail: AlbumDetail) {
  const { album, tracks } = detail;
  const cover = mediaSrc(album.cover_key, album.cover_url);
  return layout(
    `${album.title} · medialib`,
    html`
      <a href="${musicHref("albums")}" class="text-sm text-slate-500 hover:underline">← Albums</a>
      <div class="flex flex-col sm:flex-row gap-6 mt-3 mb-8">
        <div class="shrink-0 w-40">
          ${cover
            ? html`<img loading="lazy" decoding="async" src="${cover}" alt="" class="w-40 aspect-square rounded-xl object-cover bg-slate-100" />`
            : html`<div class="w-40 aspect-square rounded-xl bg-slate-100 flex items-center justify-center text-slate-300 text-3xl">♪</div>`}
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-bold tracking-tight">${album.title}</h1>
          <a href="/edit/album/${album.id}" class="inline-block mt-2 text-sm text-emerald-700 hover:underline">Edit</a>
          <p class="text-sm text-slate-500 mt-1">
            ${album.artist_id && album.artist ? html`<a href="/artist/${album.artist_id}" class="hover:underline">${album.artist}</a>` : "Unknown artist"}
            ${album.year ? ` · ${album.year}` : ""}
            ${album.tracks ? ` · ${album.tracks} tracks` : ""}
          </p>
          <div class="text-sm text-slate-600 flex items-center gap-2 mt-4">Rating ${stars("album", album.id, album.rating)}</div>
        </div>
      </div>
      ${tracks.length ? html`<h2 class="font-semibold mb-2">Tracks</h2>${trackRows(tracks)}` : ""}
    `,
  );
}

export function trackPage(detail: TrackDetail) {
  const { track, artists } = detail;
  const artistLinks = artists.length
    ? artists.map((a, i) => html`${i ? ", " : ""}<a href="/artist/${a.id}" class="hover:underline">${a.name}</a>`)
    : [html`${artistText(track)}`];
  const meta = [track.album, fmtDuration(track.duration_ms)].filter(Boolean).join(" · ");
  return layout(
    `${track.title} · medialib`,
    html`
      <a href="${musicHref("tracks")}" class="text-sm text-slate-500 hover:underline">← Tracks</a>
      <div class="mt-3">
        <h1 class="text-2xl font-bold tracking-tight">${track.title}</h1>
        <a href="/edit/track/${track.id}" class="inline-block mt-2 text-sm text-emerald-700 hover:underline">Edit</a>
        <p class="text-sm text-slate-500 mt-1">${artistLinks}</p>
        ${meta ? html`<p class="text-sm text-slate-500 mt-1">${meta}</p>` : ""}
        <div class="flex items-center gap-4 mt-4">
          <span class="text-sm text-slate-600 flex items-center gap-2">Rating ${stars("track", track.id, track.rating)}</span>
          ${favBtn(track.id, !!track.favorite)}
        </div>
      </div>
    `,
  );
}

export function artistPage(detail: ArtistDetail) {
  const { artist, albums, tracks } = detail;
  return layout(
    `${artist.name} · medialib`,
    html`
      <a href="/library" class="text-sm text-slate-500 hover:underline">← Music</a>
      <div class="flex items-center gap-4 mt-3 mb-8">
        ${mediaSrc(artist.image_key, artist.image_url)
          ? html`<img loading="lazy" decoding="async" src="${mediaSrc(artist.image_key, artist.image_url)}" alt="" class="w-20 h-20 rounded-full object-cover bg-slate-100" />`
          : html`<span class="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center text-slate-300 text-2xl">♪</span>`}
        <div>
          <h1 class="text-2xl font-bold tracking-tight">${artist.name}</h1>
          <a href="/edit/artist/${artist.id}" class="inline-block mt-2 text-sm text-emerald-700 hover:underline">Edit</a>
          <p class="text-sm text-slate-500">${ARTIST_TYPE_LABELS[artist.artist_type] ?? artist.artist_type}${artist.genres ? ` · ${artist.genres}` : ""}</p>
        </div>
      </div>
      ${albums.length
        ? html`<h2 class="font-semibold mb-2">Albums</h2>
            <div class="mb-8">${albumGrid(albums)}</div>`
        : ""}
      ${tracks.length
        ? html`<h2 class="font-semibold mb-2">Tracks</h2>${trackRows(tracks)}`
        : ""}
    `,
  );
}

export function searchPage(query: string, results: SearchResult[]) {
  const q = query.trim();
  const rows = results.length
    ? results.map(
        (r) => html`
          <a href="${r.href}" class="grid sm:grid-cols-[7rem_1fr] gap-1 sm:gap-4 px-4 py-3 hover:bg-slate-50">
            <span class="text-xs uppercase tracking-wide text-slate-400">${r.type}</span>
            <span class="min-w-0">
              <span class="block text-sm font-medium truncate">${r.name}</span>
              ${r.sub ? html`<span class="block text-xs text-slate-500 truncate">${r.sub}</span>` : ""}
            </span>
          </a>
        `,
      )
    : [
        q
          ? html`<p class="text-sm text-slate-500 px-4 py-3">No matches for "${q}".</p>`
          : html`<p class="text-sm text-slate-500 px-4 py-3">Search artists, tracks, albums, books, movies, series, anime, manga, webtoons, and comics.</p>`,
      ];
  return layout(
    "Search · medialib",
    html`
      <div class="max-w-2xl">
        <h1 class="text-2xl font-bold tracking-tight mb-5">Search</h1>
        <form action="/search" method="get" class="flex gap-2 mb-5">
          <input name="q" type="search" value="${q}" autofocus placeholder="Search library"
            class="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10" />
          <button class="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm hover:bg-slate-700">Search</button>
        </form>
        <div class="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">${rows}</div>
      </div>
    `,
  );
}
