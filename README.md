<img width="1248" height="342" alt="image" src="https://github.com/user-attachments/assets/8ae40da5-27c9-4131-a07c-dfa69d4d1a7a" />


A collaborative image board where you paste screenshots into columns and search the text inside them. OCR runs locally in your browser. Images are stored in Supabase and automatically deleted after 7 days.

## How it works

- Create or join a room with a 6-character code
- Add columns to organise your images
- Paste images with Ctrl+V into a focused column
- OCR runs locally in your browser using Scribe.js and Tesseract.js as fallback
- On mobile, OCR is skipped — desktop users in the same room automatically pick up images with no text, run OCR, and push the result so everyone sees it update in real time
- Only one desktop client runs OCR on a given image at a time (distributed lock via Supabase, expires after 2 minutes)
- All connected users see uploads and deletes in real time
- Use Ctrl+F to search text across all images
- Export everything as a ZIP, organized by column name
- Delete your own images/columns (ownership tracked by IP address)

