/** Open Library enrichment for books: cover, page count, publish year, OLID. */
export async function enrichBook(input: {
  title: string;
  author: string;
  isbn?: string;
}): Promise<{ olid?: string; coverUrl?: string; pageCount?: number; year?: number } | null> {
  const params = new URLSearchParams({ limit: "1" });
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
  const doc = data.docs?.[0];
  if (!doc) return null;

  const coverId = doc.cover_i;
  const olid = typeof doc.key === "string" ? doc.key.split("/").pop() : undefined;
  return {
    olid,
    coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : undefined,
    pageCount: Number.isFinite(Number(doc.number_of_pages_median)) ? Number(doc.number_of_pages_median) : undefined,
    year: Number.isFinite(Number(doc.first_publish_year)) ? Number(doc.first_publish_year) : undefined,
  };
}
