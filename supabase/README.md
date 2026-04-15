# OCRGRID — Supabase Setup

This folder contains everything you need to spin up your own OCRGRID backend on Supabase.

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
3. Choose a name (e.g. `ocrgrid`), set a database password, pick a region close to your users, and click **Create new project**.
4. Wait ~1 minute for the project to finish provisioning.

---

## 2. Run the schema

1. In your project dashboard, open **SQL Editor** (left sidebar).
2. Click **New query**.
3. Paste the entire contents of [`schema.sql`](./schema.sql) into the editor.
4. Click **Run**.

This creates:
- `columns` table — one row per column a user creates in a room
- `images` table — one row per uploaded image (stores base64 JPEG + OCR text)
- Indexes on `room_code` and `column_id` for fast lookups
- Open RLS policies so the anon key can read, insert, update, and delete
- Realtime enabled on both tables so all connected clients see live updates

---

## 3. Get your credentials

1. In the dashboard go to **Project Settings → API**.
2. Copy:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **anon / public** key (the long `eyJ…` string)

---

## 4. Wire up the app

Copy `config.example.js` to `config.js` and fill in your credentials:

```js
// config.js
const SUPABASE_URL  = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY';
```

`config.js` is gitignored — never commit real credentials.

---

## Schema overview

### `columns`

| Column       | Type        | Notes                              |
|--------------|-------------|------------------------------------|
| `id`         | uuid (PK)   | auto-generated                     |
| `room_code`  | text        | 6-char room identifier             |
| `name`       | text        | display name of the column         |
| `created_by` | text        | uploader's IP address              |
| `position`   | integer     | left-to-right order                |
| `created_at` | timestamptz | auto-set on insert                 |

### `images`

| Column        | Type        | Notes                              |
|---------------|-------------|------------------------------------|
| `id`          | uuid (PK)   | auto-generated                     |
| `room_code`   | text        | 6-char room identifier             |
| `column_id`   | uuid (FK)   | references `columns.id`; cascades  |
| `image_data`  | text        | base64 JPEG data URL (max ~900px)  |
| `file_name`   | text        | original filename                  |
| `ocr_text`    | text        | extracted text (Tesseract.js)      |
| `uploader_id` | text        | uploader's IP address              |
| `uploaded_at` | timestamptz | auto-set on insert                 |

---

## Ownership model

OCRGRID does not use Supabase Auth. Instead:

- On page load the app fetches the visitor's public IP via `api.ipify.org`.
- That IP is stored in `uploader_id` / `created_by` on every insert.
- The delete button is only rendered when the current IP matches the stored value.
- RLS policies are intentionally open — enforcement is client-side.

This is intentional for a zero-login collaborative tool. If you need stricter access control, replace the IP logic with Supabase Auth and tighten the RLS policies accordingly.
