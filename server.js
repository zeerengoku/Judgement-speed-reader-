const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.use(express.json({ limit: '12mb' }));
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/health', (_req, res) => res.status(200).json({ ok: true, app: 'judgment-speed-reader' }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

function cleanText(t = '') {
  return t
    .replace(/\r/g, '')
    .replace(/\f/g, '\n')
    .replace(/^[ \t]*\d+[ \t]*$/gm, '')
    .replace(/^\s*Page\s+\d+(?:\s+of\s+\d+)?\s*$/gim, '')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function paragraphs(text) {
  return text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean).map((text, i) => ({ n: i + 1, text }));
}

const responseSchema = {
  type: 'OBJECT',
  properties: {
    citation: { type: 'OBJECT', properties: {
      case_name: { type: 'STRING' }, neutral_citation: { type: 'STRING' }, court: { type: 'STRING' },
      coram: { type: 'ARRAY', items: { type: 'STRING' } }, date: { type: 'STRING' }
    }, required: ['case_name','neutral_citation','court','coram','date'] },
    parties: { type: 'OBJECT', properties: {
      appellant_or_petitioner: { type: 'STRING' }, respondent: { type: 'STRING' }
    }, required: ['appellant_or_petitioner','respondent'] },
    headnote: { type: 'STRING' },
    statutes: { type: 'ARRAY', items: { type: 'STRING' } },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
    holdings: { type: 'ARRAY', items: { type: 'STRING' } },
    final_order: { type: 'STRING' },
    key_paragraphs: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      paragraph_number: { type: 'INTEGER' }, importance: { type: 'STRING' }, reason: { type: 'STRING' }, excerpt: { type: 'STRING' }
    }, required: ['paragraph_number','importance','reason','excerpt'] } }
  },
  required: ['citation','parties','headnote','statutes','issues','holdings','final_order','key_paragraphs']
};

function buildPrompt(text) {
  return `You are a senior Indian legal research assistant. Analyze ONE Indian Supreme Court or High Court judgment. Return only JSON matching the supplied schema. Preserve the paragraph numbering implied by the source text; the source paragraphs are numbered sequentially by this application. Do not invent facts. Use empty strings/arrays where unavailable. Issues must be the actual legal questions decided. Holdings must align by index with issues. Statutes must include every Act/Code and section/rule/article expressly referenced. Select 5-10 ratio-bearing paragraphs when available, not merely factual paragraphs. Keep excerpts under 45 words. Distinguish ratio/holding from submissions and obiter.\n\nJUDGMENT:\n${text}`;
}

async function analyzeWithGemini(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Set GEMINI_API_KEY on the server.');

  // The app can be configured with GEMINI_MODELS as a comma-separated list.
  // If omitted, use a quality-first fallback chain. We only fall back for
  // transient/capacity/model-availability errors, not bad requests or auth errors.
  const models = (process.env.GEMINI_MODELS || [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite'
  ].join(','))
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  const errors = [];

  for (const model of models) {
    try {
      const result = await requestGemini(model, text, key);
      return { ...result, modelUsed: model, attemptedModels: models };
    } catch (err) {
      errors.push({ model, status: err.status || 0, message: err.message });
      if (!isFallbackError(err)) throw err;
    }
  }

  const summary = errors.map(e => `${e.model}: ${e.message}`).join(' | ');
  const error = new Error(`All Gemini models were unavailable. ${summary}`);
  error.status = 503;
  throw error;
}

function isFallbackError(err) {
  // 429 = quota/rate/capacity; 500/502/503/504 = transient provider issues.
  // Some Gemini responses use 529 for overloaded capacity.
  return [408, 429, 500, 502, 503, 504, 529].includes(Number(err.status));
}

async function requestGemini(model, text, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(text) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let r;
  let j;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    j = await r.json();
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? `Gemini ${model} timed out.` : `Gemini ${model} network error: ${e.message}`);
    err.status = 503;
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!r.ok) {
    const err = new Error(j.error?.message || `Gemini request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }

  const raw = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!raw) {
    const err = new Error(`Gemini ${model} returned no analysis.`);
    err.status = 503;
    throw err;
  }

  try {
    return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
  } catch (e) {
    const err = new Error(`Gemini ${model} returned invalid JSON: ${e.message}`);
    err.status = 502;
    throw err;
  }
}

app.post('/api/analyze', async (req, res) => {
  try {
    const text = cleanText(req.body.text || '');
    if (!text) return res.status(400).json({ error: 'No judgment text.' });
    const analysis = await analyzeWithGemini(text);
    res.json({ cleaned: text, paragraphs: paragraphs(text), analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF.' });
    const data = await pdfParse(req.file.buffer);
    const text = cleanText(data.text);
    res.json({ text, paragraphs: paragraphs(text), pdfBase64: req.file.buffer.toString('base64'), filename: req.file.originalname });
  } catch (e) { res.status(400).json({ error: 'PDF extraction failed: ' + e.message }); }
});

app.get('/api/config', (_req, res) => res.json({ provider: 'Gemini', mode: 'auto', models: (process.env.GEMINI_MODELS || 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite').split(',').map(x => x.trim()).filter(Boolean) }));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Judgment Speed Reader running on port ${PORT}`));
