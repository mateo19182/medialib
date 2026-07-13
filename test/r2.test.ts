import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheImage } from "../src/r2";

describe("image cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the WEBTOON referrer required by its image CDN", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("image", {
      headers: { "content-type": "image/jpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const put = vi.fn().mockResolvedValue(undefined);

    await cacheImage(
      { MEDIA: { put } } as never,
      "https://webtoon-phinf.pstatic.net/example.jpg?type=q90",
      "media/1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://webtoon-phinf.pstatic.net/example.jpg?type=q90",
      { headers: { referer: "https://www.webtoons.com/" } },
    );
    expect(put).toHaveBeenCalledOnce();
  });
});
