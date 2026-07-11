#!/usr/bin/env node
import fs from "node:fs";

function usage() {
  console.error("Usage: node scripts/import-goodreads-export.mjs /path/to/goodreads_library_export.csv > goodreads-import.sql");
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          field += "\"";
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function normalize(s) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function cleanIsbn(v) {
  const cleaned = cleanText(v).replace(/^="/, "").replace(/"$/, "").replace(/[^0-9Xx]/g, "");
  return cleaned || null;
}

function intOrNull(v) {
  const n = Number.parseInt(cleanText(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ratingOrNull(v) {
  const n = Number(cleanText(v));
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(5, Math.round(n))) : null;
}

function status(v) {
  switch (cleanText(v)) {
    case "read":
      return "read";
    case "currently-reading":
      return "reading";
    case "to-read":
      return "want";
    default:
      return null;
  }
}

function authors(row) {
  const names = [row.Author, ...cleanText(row["Additional Authors"]).split(/\s*,\s*/)]
    .map(cleanText)
    .filter(Boolean);
  return [...new Set(names)];
}

function q(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function bookMatch(book) {
  if (book.isbn) return `(isbn = ${q(book.isbn)} OR (normalized_title = ${q(book.normalizedTitle)} AND isbn IS NULL))`;
  return `(normalized_title = ${q(book.normalizedTitle)} AND isbn IS NULL)`;
}

function bookIdExpr(book) {
  const order = book.isbn ? `CASE WHEN isbn = ${q(book.isbn)} THEN 0 ELSE 1 END, id` : "id";
  return `(SELECT id FROM books WHERE ${bookMatch(book)} ORDER BY ${order} LIMIT 1)`;
}

const [path] = process.argv.slice(2);
if (!path) usage();

const rows = parseCsv(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const books = rows
  .map((row) => {
    const title = cleanText(row.Title);
    const sourceId = cleanText(row["Book Id"]);
    const isbn = cleanIsbn(row.ISBN13) ?? cleanIsbn(row.ISBN);
    return {
      row,
      title,
      normalizedTitle: normalize(title),
      sourceId,
      sourceUrl: sourceId ? `https://www.goodreads.com/book/show/${sourceId}` : null,
      isbn,
      year: intOrNull(row["Original Publication Year"]) ?? intOrNull(row["Year Published"]),
      publisher: cleanText(row.Publisher) || null,
      pageCount: intOrNull(row["Number of Pages"]),
      readingStatus: status(row["Exclusive Shelf"]),
      rating: ratingOrNull(row["My Rating"]),
      review: cleanText(row["My Review"]) || null,
      authors: authors(row),
    };
  })
  .filter((book) => book.title && book.sourceId);

console.log("BEGIN TRANSACTION;");

for (const book of books) {
  const match = bookMatch(book);
  const idExpr = bookIdExpr(book);
  console.log(
    `INSERT INTO books (title, normalized_title, isbn, year, publisher, page_count, reading_status, rating, review)
SELECT ${q(book.title)}, ${q(book.normalizedTitle)}, ${q(book.isbn)}, ${q(book.year)}, ${q(book.publisher)}, ${q(book.pageCount)}, ${q(book.readingStatus)}, ${q(book.rating)}, ${q(book.review)}
WHERE NOT EXISTS (SELECT 1 FROM books WHERE ${match});`,
  );
  console.log(
    `UPDATE books
SET title = ${q(book.title)},
    normalized_title = ${q(book.normalizedTitle)},
    isbn = COALESCE(isbn, ${q(book.isbn)}),
    year = COALESCE(${q(book.year)}, year),
    publisher = COALESCE(${q(book.publisher)}, publisher),
    page_count = COALESCE(${q(book.pageCount)}, page_count),
    reading_status = COALESCE(${q(book.readingStatus)}, reading_status),
    rating = COALESCE(${q(book.rating)}, rating),
    review = COALESCE(${q(book.review)}, review)
WHERE ${match};`,
  );

  for (const [position, author] of book.authors.entries()) {
    console.log(`INSERT OR IGNORE INTO authors (name, normalized_name) VALUES (${q(author)}, ${q(normalize(author))});`);
    console.log(
      `INSERT OR IGNORE INTO book_authors (book_id, author_id, position)
VALUES (${idExpr}, (SELECT id FROM authors WHERE normalized_name = ${q(normalize(author))}), ${position});`,
    );
  }

  const raw = {
    goodreadsId: book.sourceId,
    title: book.title,
    authors: book.authors,
    isbn: book.isbn,
    shelf: cleanText(book.row["Exclusive Shelf"]) || null,
    bookshelves: cleanText(book.row.Bookshelves) || null,
    dateRead: cleanText(book.row["Date Read"]) || null,
    dateAdded: cleanText(book.row["Date Added"]) || null,
    readCount: intOrNull(book.row["Read Count"]),
    ownedCopies: intOrNull(book.row["Owned Copies"]),
  };
  console.log(
    `INSERT OR IGNORE INTO links (url, source, source_kind, source_id, entity_type, entity_id, title, status, raw_json, saved_via)
VALUES (${q(book.sourceUrl)}, 'goodreads', 'book', ${q(book.sourceId)}, 'book', ${idExpr}, ${q(book.title)}, 'ok', ${q(JSON.stringify(raw))}, 'import');`,
  );
  console.log(
    `UPDATE links
SET url = ${q(book.sourceUrl)}, entity_type = 'book', entity_id = ${idExpr}, title = ${q(book.title)}, status = 'ok', raw_json = ${q(JSON.stringify(raw))}, saved_via = 'import'
WHERE source = 'goodreads' AND source_kind = 'book' AND source_id = ${q(book.sourceId)};`,
  );
}

console.log("COMMIT;");
console.error(`Prepared ${books.length} Goodreads books`);
