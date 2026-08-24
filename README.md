# Judgment Speed Reader — mobile-first v2

A single-screen Indian Supreme Court / High Court judgment comprehension app. The primary target is a phone browser/PWA, while desktop remains supported.

## What changed

- Gemini API replaces Claude/Anthropic.
- `GEMINI_API_KEY` stays server-side.
- Default model: `gemini-2.5-flash` (override with `GEMINI_MODEL`).
- Mobile-first responsive UI with a Judgment/Breakdown tab switch.
- PDF upload preserves the original PDF and renders it with PDF.js in the reader pane.
- AI key-paragraph navigation attempts to locate the matching source paragraph in the rendered PDF and scrolls to its page.
- Pasted text gets numbered paragraph anchors.
- Search highlighting, skim mode, key-paragraph mode and TL;DR mode are retained.
- PWA manifest/service worker included so the site can be installed from a mobile browser when hosted over HTTPS.
- Neutral citation lookup opens a web search for the citation; authoritative court-source integration remains a separate backend task.

## Run locally

Requirements: Node.js 20+.

```bash
npm install
```

Create `.env` or set the environment variable in your shell:

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

This project intentionally does not ship dotenv, so set the variables in your hosting platform or shell. On Windows PowerShell:

```powershell
$env:GEMINI_API_KEY="your_key_here"
npm start
```

Then open `http://localhost:3000`.

## Phone use

For a phone, do not expose the Node server directly to the public internet without HTTPS/authentication. Deploy the Node app to a Node-capable host, set `GEMINI_API_KEY` as a server secret, then open the HTTPS URL on the phone. Use the browser's **Add to Home Screen / Install app** command to make it behave like an app.

The Gemini key must never be placed in `public/index.html` or shipped to the phone.

## Current scope

Implemented: PDF upload, PDF.js rendering, pasted text, text cleaning, Gemini structured JSON analysis, citation/bench, parties, headnote, statutes, issues, holdings, final order, key paragraphs, search, skim, density modes, mobile tabs, PWA shell, paragraph/page jump attempt.

Still needed for a production legal-research product: OCR fallback for scanned PDFs, exact PDF text-to-paragraph coordinate mapping, persistent accounts/notes/folders, export to PDF/Word, official neutral-citation lookup, library-wide search/filtering, authentication/rate limits, and encrypted user data.
