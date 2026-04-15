-- ═══════════════════════════════════════════════════════════════
-- OCRGRID — Supabase schema
-- Run this entire file in the Supabase SQL editor to set up a
-- fresh project from scratch.
-- ═══════════════════════════════════════════════════════════════


-- ── Tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.columns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code  text        NOT NULL,
  name       text        NOT NULL DEFAULT 'Column',
  created_by text,                        -- stores uploader IP
  position   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.images (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code      text        NOT NULL,
  column_id      uuid REFERENCES public.columns(id) ON DELETE CASCADE,
  image_data     text,                        -- base64 JPEG data URL
  file_name      text,
  ocr_text       text        NOT NULL DEFAULT '',
  uploader_id    text,                        -- stores uploader IP
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  ocr_locked_by  text,                        -- IP of client currently running OCR
  ocr_locked_at  timestamptz                  -- lock timestamp; expires after 2 minutes
);


-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS columns_room_code_idx ON public.columns(room_code);
CREATE INDEX IF NOT EXISTS images_room_code_idx  ON public.images(room_code);
CREATE INDEX IF NOT EXISTS images_column_id_idx  ON public.images(column_id);


-- ── Row Level Security ────────────────────────────────────────
-- All access is open (anon key).  Ownership enforcement (who can
-- see the delete button) is handled client-side via IP address.

ALTER TABLE public.columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.images  ENABLE ROW LEVEL SECURITY;

-- columns
CREATE POLICY "open_read"   ON public.columns FOR SELECT USING (true);
CREATE POLICY "open_insert" ON public.columns FOR INSERT WITH CHECK (true);
CREATE POLICY "open_update" ON public.columns FOR UPDATE USING (true);
CREATE POLICY "open_delete" ON public.columns FOR DELETE USING (true);

-- images
CREATE POLICY "open_read"   ON public.images FOR SELECT USING (true);
CREATE POLICY "open_insert" ON public.images FOR INSERT WITH CHECK (true);
CREATE POLICY "open_update" ON public.images FOR UPDATE USING (true);
CREATE POLICY "open_delete" ON public.images FOR DELETE USING (true);


-- ── Realtime ──────────────────────────────────────────────────
-- Enable realtime publications so clients receive live updates.

ALTER PUBLICATION supabase_realtime ADD TABLE public.columns;
ALTER PUBLICATION supabase_realtime ADD TABLE public.images;


-- ── DB usage function ─────────────────────────────────────────
-- Returns the total bytes of live image data stored.
-- Responds immediately to deletes (unlike pg_database_size).

CREATE OR REPLACE FUNCTION public.get_db_size()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(
    length(COALESCE(image_data, '')) +
    length(COALESCE(ocr_text, '')) +
    length(COALESCE(file_name, ''))
  ), 0)::bigint
  FROM images;
$$;

GRANT EXECUTE ON FUNCTION public.get_db_size() TO anon;


-- ── Auto-cleanup ──────────────────────────────────────────────
-- Deletes images older than 7 days every day at 3am UTC.

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'delete-old-images',
  '0 3 * * *',
  $$
    DELETE FROM public.images WHERE uploaded_at < now() - interval '7 days';
    DELETE FROM public.columns
      WHERE id NOT IN (SELECT DISTINCT column_id FROM public.images WHERE column_id IS NOT NULL);
  $$
);
