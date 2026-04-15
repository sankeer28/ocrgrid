# OCRGRID

A collaborative image board where you paste screenshots into columns and search the text inside them. OCR runs locally in your browser — nothing is sent to any server except the image data stored in your own Supabase project.

## How it works

- Create or join a room with a 6-character code
- Add columns to organise your images
- Paste images with Ctrl+V into a focused column
- OCR runs locally in your browser using Scribe.js (with optional Tesseract fallback)
- All connected users see uploads and deletes in real time
- Use Ctrl+F to search text across all images
- Export everything as a ZIP, organized by column name
- Delete your own images/columns (ownership tracked by IP address)

## Technologies

- **Supabase** — Postgres database + realtime subscriptions
- **Scribe.js OCR** — primary in-browser OCR engine (vendored in this repo)
- **Tesseract.js** — fallback OCR engine for compatibility
- **JSZip** — client-side ZIP export
- **Vanilla JS / CSS** — no framework

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run the contents of [`supabase/schema.sql`](./supabase/schema.sql)
3. Go to **Project Settings → API** and copy your Project URL and anon key
4. Copy `config.example.js` to `config.js` and fill in your credentials:

```js
const SUPABASE_URL  = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY';
```

Then open `index.html` in a browser or serve it with any static file server.
