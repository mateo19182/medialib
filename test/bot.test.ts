import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { extractUrls, parseCommand } from "../src/bot/telegram";
import { isTextAddKind } from "../src/ingest/text";

describe("bot helpers", () => {
  it("extracts urls from a message", () => {
    expect(extractUrls("check this https://open.spotify.com/track/abc and https://youtu.be/xyz")).toEqual([
      "https://open.spotify.com/track/abc",
      "https://youtu.be/xyz",
    ]);
    expect(extractUrls("no links here")).toEqual([]);
  });

  it("parses commands with args", () => {
    expect(parseCommand("/search daft punk")).toEqual({ cmd: "search", args: "daft punk" });
    expect(parseCommand("/stats")).toEqual({ cmd: "stats", args: "" });
    expect(parseCommand("/help@medialib_bot")).toEqual({ cmd: "help", args: "" });
    expect(parseCommand("just text")).toBeNull();
  });

  it("recognizes the media kinds offered by /add", () => {
    expect(isTextAddKind("book")).toBe(true);
    expect(isTextAddKind("series")).toBe(true);
    expect(isTextAddKind("podcast")).toBe(false);
  });
});

describe("webhook route", () => {
  it("reports application processing time", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+\.\d$/);
  });

  it("returns 200 for an update (work happens in background)", async () => {
    const res = await SELF.fetch("https://example.com/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: "/help" } }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a malformed body", async () => {
    const res = await SELF.fetch("https://example.com/telegram/webhook", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });
});
