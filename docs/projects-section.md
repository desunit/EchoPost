# Projects section

A small, static "Projects" area on the public site. It is not backed by the
database — the pages are plain Eta templates and hard-coded routes.

## Routes

Both routes live in `src/routes/public.ts` (registered before the `/:slug`
catch-all; Fastify gives static routes priority over parametric ones anyway):

| Path | Template | Purpose |
|------|----------|---------|
| `/projects` | `views/projects.eta` | Index of projects |
| `/projects/text-watermark` | `views/project-text-watermark.eta` | Text Watermark tool |

Both paths are added to the sitemap in `src/modules/seo/service.ts` and to the
header/footer nav in `views/layout.eta`.

To add a project, add a `<li>` to `views/projects.eta`. For a project with its
own page, add a route + template and a sitemap entry.

## Text Watermark tool

A client-side utility. All logic is in `src/public/text-watermark.js`
(served from `/assets/`); no text ever leaves the browser, so it works under
the strict CSP with no changes (`script-src 'self'`).

Two modes:

- **Check & Clean** — scans text for invisible Unicode characters, lists each
  code point with its name and count, tries to decode an embedded watermark,
  and can strip every invisible character.
- **Embed** — encodes a message as zero-width characters and inserts it after
  the first word of the text.

### Watermark encoding

The message is UTF-8 encoded, then each bit is written as a zero-width
character:

- `0` → `U+200C` zero-width non-joiner
- `1` → `U+200D` zero-width joiner
- payload is wrapped in `U+2060` word-joiner markers as delimiters

The payload is inserted after the first whitespace-delimited word so it
survives leading/trailing trims and most copy-paste. Decoding finds the
`U+2060`-delimited run, regroups the bits into bytes, and UTF-8 decodes them
(with `fatal: true`, so noise decodes to "no watermark" rather than garbage).

### Detection inventory

The checker recognises a broader set of invisible characters than it embeds:
soft hyphen, combining grapheme joiner, Arabic letter mark, zero-width space,
BOM/ZWNBSP, bidi controls and isolates, variation selectors, Mongolian
selectors, and Unicode tag characters (`U+E0000`–`U+E007F`).

Cleaning removes all of them. Caveat: this also removes joiners and variation
selectors that some composed emoji depend on — noted in the UI.
