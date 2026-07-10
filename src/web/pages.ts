import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { LibraryStats } from "../types";

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

const STAT_LABELS: [keyof LibraryStats, string][] = [
  ["tracks", "tracks"],
  ["artists", "artists"],
  ["albums", "albums"],
  ["books", "books"],
  ["links", "saved links"],
];

export function dashboard(stats: LibraryStats, recent: Record<string, unknown>[]) {
  const cards = STAT_LABELS.map(
    ([k, label]) => html`
      <div class="bg-white border border-slate-200 rounded-xl p-5">
        <div class="text-3xl font-bold tracking-tight">${stats[k]}</div>
        <div class="text-sm text-slate-500 mt-0.5">${label}</div>
      </div>
    `,
  );

  const rows = recent.length
    ? recent.map(
        (r) => html`
          <a
            href="${String(r.url)}"
            target="_blank"
            rel="noopener"
            class="flex items-center justify-between gap-3 py-2 px-1 hover:bg-slate-50 rounded-lg"
          >
            <span class="min-w-0 flex-1 truncate text-sm">${String(r.url)}</span>
            <span class="text-xs text-slate-400 whitespace-nowrap">${String(r.source)} · ${String(r.status)}</span>
          </a>
        `,
      )
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
        <h2 class="font-semibold mb-2">Recently saved</h2>
        <div class="divide-y divide-slate-100">${rows}</div>
      </div>
      ${raw("")}
    `,
  );
}
