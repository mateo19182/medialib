import { describe, expect, it } from "vitest";
import { dashboard } from "../src/web/pages";

const emptyStats = {
  tracks: 0,
  artists: 0,
  albums: 0,
  books: 0,
  movies: 0,
  series: 0,
  anime: 0,
  manga: 0,
  webtoons: 0,
  comics: 0,
  links: 0,
  pending: 0,
};

describe("web app shell", () => {
  it("advertises an installable mobile experience", () => {
    const page = String(dashboard(emptyStats));

    expect(page).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(page).toContain('name="theme-color" content="#0f172a"');
    expect(page).toContain('rel="manifest" href="/app.webmanifest"');
    expect(page).toContain('src="/assets/app.js"');
  });

  it("provides compact mobile actions and scrollable section navigation", () => {
    const page = String(dashboard(emptyStats));

    expect(page).toContain('class="nav-scroll lg:hidden overflow-x-auto');
    expect(page).toContain('href="/search" class="min-h-10');
    expect(page).toContain('href="/add" class="min-h-10');
  });
});
