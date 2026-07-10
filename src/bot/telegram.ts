import type { Env } from "../types";
import { getLibrary } from "../types";

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
}

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function send(env: Env, chatId: number, text: string): Promise<void> {
  return tgCall(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

const HELP = [
  "🎵 <b>medialib</b> — send me a Spotify, YouTube, Bandcamp, or Goodreads link and I'll save it.",
  "",
  "Commands:",
  "/search &lt;query&gt; — find saved items",
  "/recent — recently saved",
  "/stats — library counts",
].join("\n");

// --- routing ----------------------------------------------------------------
async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  if (!text) return;

  const command = parseCommand(text);
  if (command && extractUrls(text).length === 0) {
    return handleCommand(command.cmd, command.args, chatId, env);
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    await send(env, chatId, "Send me a link, or /help.");
    return;
  }

  const lib = getLibrary(env);
  for (const url of urls) {
    try {
      const r = await lib.saveLink(url, "telegram");
      if (!r.ok) await send(env, chatId, `⚠️ ${escapeHtml(r.error ?? "Could not save")}: ${escapeHtml(url)}`);
      else if (r.duplicate) await send(env, chatId, `↩️ Already saved: <b>${escapeHtml(r.title ?? url)}</b>`);
      else if (r.status === "ok") await send(env, chatId, `✅ Saved <b>${escapeHtml(r.title ?? url)}</b> <i>(${r.entityType})</i>`);
      else await send(env, chatId, `💾 Saved link (no metadata${r.error ? `: ${escapeHtml(r.error)}` : ""})`);
    } catch (e) {
      await send(env, chatId, `❌ Error: ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
    }
  }
}

async function handleCommand(cmd: string, args: string, chatId: number, env: Env): Promise<void> {
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
        `📊 <b>${s.tracks}</b> tracks · <b>${s.artists}</b> artists · <b>${s.albums}</b> albums · <b>${s.books}</b> books\n<b>${s.links}</b> saved links`,
      );
    }
    case "recent": {
      const rows = await lib.recent(10);
      if (!rows.length) return send(env, chatId, "Nothing saved yet.");
      const lines = rows.map((r) => `• <b>${escapeHtml(String(r.title || r.url))}</b> <i>(${String(r.source)})</i>`);
      return send(env, chatId, lines.join("\n"));
    }
    case "search": {
      if (!args) return send(env, chatId, "Usage: /search &lt;query&gt;");
      const hits = await lib.search(args, 10);
      if (!hits.length) return send(env, chatId, `No matches for “${escapeHtml(args)}”.`);
      const lines = hits.map((h) => `• ${h.type}: <b>${escapeHtml(h.name)}</b>${h.sub ? ` — ${escapeHtml(h.sub)}` : ""}`);
      return send(env, chatId, lines.join("\n"));
    }
    default:
      return send(env, chatId, "Unknown command. /help");
  }
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
  // Always 200 so Telegram stops retrying (ignored senders included).
  return new Response("ok");
}

/** Register this deployment's webhook with Telegram (call once after deploy). */
export async function registerWebhook(publicUrl: string, env: Env): Promise<void> {
  await tgCall(env, "setWebhook", {
    url: publicUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "edited_message"],
  });
}
