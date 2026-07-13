type OpenLibraryDoc = Record<string, unknown>;

export interface OpenLibraryBookMatch {
  olid?: string;
  isbn?: string;
  coverUrl?: string;
  pageCount?: number;
  year?: number;
  title?: string;
  author?: string;
}

function normalizedTitle(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function validIsbns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((isbn) => isbn.replace(/[^0-9X]/gi, ""));
}

function preferredIsbn(doc: OpenLibraryDoc): string | undefined {
  const isbns = [
    ...validIsbns(doc.isbn_13),
    ...validIsbns(doc.isbn),
    ...validIsbns(doc.isbn_10),
  ];
  return isbns.find((value) => /^97[89]\d{10}$/.test(value))
    ?? isbns.find((value) => /^\d{9}[\dX]$/i.test(value));
}

function coverId(doc: OpenLibraryDoc): number | undefined {
  if (Number(doc.cover_i) > 0) return Number(doc.cover_i);
  const covers = Array.isArray(doc.covers) ? doc.covers.map(Number) : [];
  return covers.find((value) => value > 0);
}

async function preferredEdition(olid: string): Promise<OpenLibraryDoc | null> {
  const r = await fetch(`https://openlibrary.org/works/${olid}/editions.json?limit=50`, {
    headers: { "user-agent": "medialib/0.1", accept: "application/json" },
  });
  if (!r.ok) throw new Error(`openlibrary editions ${r.status}`);
  const entries = ((await r.json()) as { entries?: OpenLibraryDoc[] }).entries ?? [];
  const candidates = entries.filter((entry) => preferredIsbn(entry));
  return candidates.sort((a, b) => {
    const score = (entry: OpenLibraryDoc) => (preferredIsbn(entry)?.length === 13 ? 2 : 0) + (coverId(entry) ? 1 : 0);
    return score(b) - score(a);
  })[0] ?? null;
}

/** Find an exact-title Open Library work, preferring records and editions with ISBNs. */
export async function findOpenLibraryBook(input: {
  title: string;
  author: string;
  isbn?: string;
}): Promise<OpenLibraryBookMatch | null> {
  const params = new URLSearchParams({ limit: "10" });
  if (input.isbn) params.set("isbn", input.isbn);
  else {
    params.set("title", input.title);
    if (input.author && input.author !== "Unknown") params.set("author", input.author);
  }
  const r = await fetch(`https://openlibrary.org/search.json?${params}`, {
    headers: { "user-agent": "medialib/0.1", accept: "application/json" },
  });
  if (!r.ok) throw new Error(`openlibrary ${r.status}`);
  const data = (await r.json()) as { docs?: Record<string, unknown>[] };
  const docs = data.docs ?? [];
  const exactDocs = input.isbn ? docs.slice(0, 1) : docs.filter((candidate) => normalizedTitle(candidate.title) === normalizedTitle(input.title));
  const doc = exactDocs.sort((a, b) => Number(Boolean(preferredIsbn(b))) - Number(Boolean(preferredIsbn(a))))[0];
  if (!doc) return null;

  const olid = typeof doc.key === "string" ? doc.key.split("/").pop() : undefined;
  const edition = !input.isbn && !preferredIsbn(doc) && olid ? await preferredEdition(olid) : null;
  const isbn = input.isbn ?? preferredIsbn(doc) ?? (edition ? preferredIsbn(edition) : undefined);
  const selectedCoverId = (edition && coverId(edition)) ?? coverId(doc);
  return {
    olid,
    isbn,
    coverUrl: selectedCoverId ? `https://covers.openlibrary.org/b/id/${selectedCoverId}-L.jpg` : undefined,
    pageCount: Number.isFinite(Number(doc.number_of_pages_median)) ? Number(doc.number_of_pages_median) : undefined,
    year: Number.isFinite(Number(doc.first_publish_year)) ? Number(doc.first_publish_year) : undefined,
    title: typeof doc.title === "string" ? doc.title : undefined,
    author: Array.isArray(doc.author_name) ? String(doc.author_name[0] ?? "Unknown") : "Unknown",
  };
}

/** Open Library enrichment for books: cover, page count, publish year, OLID. */
export async function enrichBook(input: { title: string; author: string; isbn?: string }): Promise<OpenLibraryBookMatch | null> {
  return findOpenLibraryBook(input);
}
