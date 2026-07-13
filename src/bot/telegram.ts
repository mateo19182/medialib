import type { Env } from "../types";
import { getLibrary } from "../types";
import { READING_STATUSES, type LiveShowInput, type RatableKind, type ReadingStatus } from "../db/library";
import { isTextAddKind, type TextAddKind } from "../ingest/text";
import { liveShows } from "../live-shows";

// --- minimal Telegram types -------------------------------------------------
interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}
interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
interface TgCallbackQuery { id: string; from: TgUser; data?: string; message?: TgMessage; }

type TelegramCallbackDiagnostic = {
  receivedAt: string;
  senderId: number;
  data: string | null;
  hasMessage: boolean;
  allowed: boolean;
  outcome: "received" | "handled" | "error";
  error?: string;
};

// --- pure helpers (unit-tested) --------------------------------------------
const URL_RE = /https?:\/\/[^\s<>]+/g;

export function extractUrls(text: string): string[] {
  return [...(text.match(URL_RE) ?? [])];
}

export function parseCommand(text: string): { cmd: string; args: string } | null {
  const m = text.trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/** Parse: Artist | YYYY-MM-DD | Venue | City | Summary | Notes | tags, comma-separated */
export function parseLiveShow(text: string): LiveShowInput | null {
  const [artist, date, venue, city, summary, notes, tags] = text.split("|").map((value) => value.trim());
  if (!artist) return null;
  return { artist, date, venue, city, summary, notes, tags };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function recordCallbackDiagnostic(env: Env, diagnostic: TelegramCallbackDiagnostic): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind("telegram:callback:last", JSON.stringify(diagnostic)).run();
}

// --- Telegram API -----------------------------------------------------------
async function tgCall(env: Env, method: string, payload: unknown): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`telegram ${method} -> ${r.status}: ${body}`);
  }
}

function send(env: Env, chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
  return tgCall(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: replyMarkup });
}

const HELP = [
  "🎵 <b>medialib</b> — send me a Spotify, YouTube, Bandcamp, Goodreads, or MyAnimeList link and I'll save it.",
  "",
  "Commands:",
  "/add — add an item by name (choose its type first)",
  "/live — add a live show",
  "/cancel — cancel the pending add",
  "/search &lt;query&gt; — find saved items",
  "/recent — recently saved",
  "/stats — library counts",
  "/rate track|album|book|media &lt;id&gt; &lt;0-5&gt; — rate an item",
  "/status &lt;bookId&gt; want|reading|read — set reading status",
  "/fav &lt;trackId&gt; — toggle favorite",
].join("\n");

const ADD_KINDS: { kind: TextAddKind | "live"; label: string }[] = [
  { kind: "track", label: "🎵 Track" }, { kind: "album", label: "💿 Album" }, { kind: "artist", label: "🎤 Artist" }, { kind: "book", label: "📚 Book" },
  { kind: "movie", label: "🎬 Movie" }, { kind: "series", label: "📺 Series" }, { kind: "anime", label: "✨ Anime" }, { kind: "manga", label: "📖 Manga" },
  { kind: "webtoon", label: "Webtoon" }, { kind: "comic", label: "Comic" },
  { kind: "live", label: "🎟️ Live show" },
];

function addKeyboard(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: ADD_KINDS.reduce<{ text: string; callback_data: string }[][]>((rows, item, index) => {
    if (index % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: item.label, callback_data: `add:${item.kind}` });
    return rows;
  }, []) };
}

// --- routing ----------------------------------------------------------------
async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  if (!text) return;

  const command = parseCommand(text);
  if (command && extractUrls(text).length === 0) {
    return handleCommand(command.cmd, command.args, chatId, msg.from?.id, env);
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    if (msg.from) {
      const mode = await getLibrary(env).takeTelegramAddMode(chatId, msg.from.id);
      if (mode === "live") return saveLiveShow(text, chatId, env);
      if (mode) return saveText(mode, text, chatId, env);
    }
    await send(env, chatId, "Send me a link, or /help.");
    return;
  }

  const lib = getLibrary(env);
  for (const url of urls) {
    try {
      const r = await lib.saveLink(url, "telegram");
      if (!r.ok) await send(env, chatId, `⚠️ ${escapeHtml(r.error ?? "Could not save")}: ${escapeHtml(url)}`);
      else if (r.duplicate) await send(env, chatId, `↩️ Already saved: <b>${escapeHtml(r.title ?? url)}</b>`);
      else if (r.status === "ok") await send(env, chatId, `✅ Saved <b>${escapeHtml(r.title ?? url)}</b> <i>(${r.itemKind ?? "link"})</i>`);
      else await send(env, chatId, `💾 Saved link (no metadata${r.error ? `: ${escapeHtml(r.error)}` : ""})`);
    } catch (e) {
      await send(env, chatId, `❌ Error: ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
    }
  }
}

async function saveLiveShow(text: string, chatId: number, env: Env): Promise<void> {
  const input = parseLiveShow(text);
  if (!input) return send(env, chatId, "⚠️ Add an artist name. Use: Artist | YYYY-MM-DD | Venue | City | Summary | Notes | tags");
  try {
    const lib = getLibrary(env);
    await lib.seedLiveShows(liveShows);
    await lib.createLiveShow(input);
    return send(env, chatId, `✅ Saved live show: <b>${escapeHtml(input.artist)}</b>${input.venue ? ` at ${escapeHtml(input.venue)}` : ""}`);
  } catch (e) {
    return send(env, chatId, `❌ Error: ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
  }
}

async function saveText(kind: TextAddKind, text: string, chatId: number, env: Env): Promise<void> {
  try {
    const r = await getLibrary(env).saveText(kind, text, "telegram");
    if (r.duplicate) return send(env, chatId, `↩️ Already saved: <b>${escapeHtml(r.title ?? text)}</b>`);
    if (!r.ok) return send(env, chatId, `⚠️ ${escapeHtml(r.error ?? "Could not save")}`);
    if (r.status === "ok") return send(env, chatId, `✅ Saved <b>${escapeHtml(r.title ?? text)}</b> <i>(${escapeHtml(kind)})</i>`);
    return send(env, chatId, `💾 Saved <b>${escapeHtml(r.title ?? text)}</b> <i>(${escapeHtml(kind)}, unverified)</i>`);
  } catch (e) {
    return send(env, chatId, `❌ Error: ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
  }
}

async function handleCommand(cmd: string, args: string, chatId: number, userId: number | undefined, env: Env): Promise<void> {
  const lib = getLibrary(env);
  switch (cmd) {
    case "start":
    case "help":
      return send(env, chatId, HELP);
    case "stats": {
      const s = await lib.stats();
      return send(
        env,
        chatId,
        `📊 <b>${s.tracks}</b> tracks · <b>${s.artists}</b> artists · <b>${s.albums}</b> albums · <b>${s.books}</b> books\n<b>${s.movies}</b> movies · <b>${s.series}</b> series · <b>${s.anime}</b> anime · <b>${s.manga}</b> manga · <b>${s.webtoons}</b> webtoons · <b>${s.comics}</b> comics\n<b>${s.links}</b> saved links`,
      );
    }
    case "add": {
      if (args) {
        const [kind, ...query] = args.split(/\s+/);
        if (isTextAddKind(kind) && query.length) return saveText(kind, query.join(" "), chatId, env);
        if (kind === "live") return args.slice(kind.length).trim() ? saveLiveShow(args.slice(kind.length).trim(), chatId, env) : startLiveShow(chatId, userId, env);
      }
      return send(env, chatId, "What would you like to add?", addKeyboard());
    }
    case "live":
      return args ? saveLiveShow(args, chatId, env) : startLiveShow(chatId, userId, env);
    case "cancel":
      if (!userId) return send(env, chatId, "⚠️ I could not identify the sender.");
      await lib.clearTelegramAddMode(chatId, userId);
      return send(env, chatId, "Cancelled.");
    case "recent": {
      const rows = await lib.recent(10);
      if (!rows.length) return send(env, chatId, "Nothing saved yet.");
      const lines = rows.map((r) => `• <b>${escapeHtml(String(r.title || r.url))}</b> <i>(${String(r.provider)})</i>`);
      return send(env, chatId, lines.join("\n"));
    }
    case "search": {
      if (!args) return send(env, chatId, "Usage: /search &lt;query&gt;");
      const hits = await lib.search(args, 10);
      if (!hits.length) return send(env, chatId, `No matches for “${escapeHtml(args)}”.`);
      const lines = hits.map((h) => `• ${h.type}: <b>${escapeHtml(h.name)}</b>${h.sub ? ` — ${escapeHtml(h.sub)}` : ""}`);
      return send(env, chatId, lines.join("\n"));
    }
    case "rate": {
      const [kind, idStr, valStr] = args.split(/\s+/);
      if (!["track", "album", "book", "media"].includes(kind) || !idStr || valStr === undefined)
        return send(env, chatId, "Usage: /rate track|album|book|media &lt;id&gt; &lt;0-5&gt;");
      const v = await lib.rate(kind as RatableKind, Number(idStr), Number(valStr));
      return send(env, chatId, `Rated ${kind} ${idStr}: ${"★".repeat(v)}${"☆".repeat(5 - v)}`);
    }
    case "status": {
      const [idStr, status] = args.split(/\s+/);
      if (!idStr || !READING_STATUSES.includes(status as ReadingStatus))
        return send(env, chatId, "Usage: /status &lt;bookId&gt; want|reading|read");
      await lib.setReadingStatus(Number(idStr), status as ReadingStatus);
      return send(env, chatId, `Book ${idStr} → ${status}`);
    }
    case "fav": {
      const id = Number(args.trim());
      if (!id) return send(env, chatId, "Usage: /fav &lt;trackId&gt;");
      const on = await lib.toggleFavorite(id);
      return send(env, chatId, on ? `♥ Favorited track ${id}` : `Removed favorite from track ${id}`);
    }
    default:
      return send(env, chatId, "Unknown command. /help");
  }
}

function startLiveShow(chatId: number, userId: number | undefined, env: Env): Promise<void> {
  if (!userId) return send(env, chatId, "⚠️ I could not identify the sender.");
  return getLibrary(env).setTelegramAddMode(chatId, userId, "live")
    .then(() => send(env, chatId, "Send: <b>Artist | YYYY-MM-DD | Venue | City | Summary | Notes | tags</b>\nOnly the artist is required; leave optional columns empty."));
}

async function handleCallback(callback: TgCallbackQuery, env: Env): Promise<void> {
  // Acknowledge the tap, but do not let a transient Telegram API failure prevent
  // the selected add mode from being stored and its prompt from being sent.
  await tgCall(env, "answerCallbackQuery", { callback_query_id: callback.id }).catch((error) => {
    console.error("telegram callback acknowledgement failed", error);
  });
  const chatId = callback.message?.chat.id;
  const kind = callback.data?.startsWith("add:") ? callback.data.slice(4) : "";
  if (!chatId || (kind !== "live" && !isTextAddKind(kind))) return;
  if (kind === "live") {
    await getLibrary(env).setTelegramAddMode(chatId, callback.from.id, kind);
    return send(env, chatId, "Send: <b>Artist | YYYY-MM-DD | Venue | City | Summary | Notes | tags</b>\nOnly the artist is required; leave optional columns empty.");
  }
  await getLibrary(env).setTelegramAddMode(chatId, callback.from.id, kind);
  const label = ADD_KINDS.find((item) => item.kind === kind)?.label ?? kind;
  await send(env, chatId, `${label}: send me its title or name and I'll find the best match.`);
}

/**
 * Webhook entry point. Validates the shared secret, checks the sender allowlist,
 * then processes the update in the background so Telegram gets an immediate 200.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (header !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update.message ?? update.edited_message;
  const allowed = env.TELEGRAM_ALLOWED_USER_ID;
  if (msg && msg.from && (!allowed || String(msg.from.id) === allowed)) {
    ctx.waitUntil(handleMessage(msg, env).catch((e) => console.error("telegram handler error", e)));
  }
  const callback = update.callback_query;
  if (callback) {
    const callbackAllowed = !allowed || String(callback.from.id) === allowed;
    await recordCallbackDiagnostic(env, {
      receivedAt: new Date().toISOString(), senderId: callback.from.id, data: callback.data ?? null,
      hasMessage: !!callback.message, allowed: callbackAllowed, outcome: "received",
    });
    if (callback.message && callbackAllowed) {
      ctx.waitUntil(handleCallback(callback, env)
        .then(() => recordCallbackDiagnostic(env, {
          receivedAt: new Date().toISOString(), senderId: callback.from.id, data: callback.data ?? null,
          hasMessage: true, allowed: true, outcome: "handled",
        }))
        .catch(async (error) => {
          console.error("telegram callback error", error);
          await recordCallbackDiagnostic(env, {
            receivedAt: new Date().toISOString(), senderId: callback.from.id, data: callback.data ?? null,
            hasMessage: true, allowed: true, outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }));
    }
  }
  // Always 200 so Telegram stops retrying (ignored senders included).
  return new Response("ok");
}

/** Register this deployment's webhook with Telegram (call once after deploy). */
export async function registerWebhook(publicUrl: string, env: Env): Promise<void> {
  await tgCall(env, "setWebhook", {
    url: publicUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "edited_message", "callback_query"],
  });
}
