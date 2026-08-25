const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 10000;

const upload = multer({
  dest: "/tmp/judgment-uploads",
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const MODELS = (
  process.env.GEMINI_MODELS ||
  "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite"
)
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const ANALYSIS_PROMPT = `
You are an expert Indian Supreme Court and High Court judgment analyst.

Read the ENTIRE supplied judgment before answering.

Return ONLY valid JSON.

Extract:

{
  "citation": {
    "case_name": "",
    "neutral_citation": "",
    "court": "",
    "coram": [],
    "date": ""
  },
  "parties": {
    "appellant_petitioner": "",
    "respondent": ""
  },
  "headnote": "",
  "statutes": [
    {
      "act": "",
      "sections": []
    }
  ],
  "issues": [
    {
      "number": 1,
      "issue": "",
      "holding": "",
      "paragraphs": []
    }
  ],
  "final_order": "",
  "key_paragraphs": [
    {
      "paragraph_number": "",
      "importance": "",
      "reason": ""
    }
  ]
}

Rules:

- Do not invent facts.
- Preserve the court's actual reasoning.
- Identify the actual questions decided by the court.
- Distinguish arguments from the court's holding.
- Identify the paragraphs carrying the ratio.
- Give paragraph numbers exactly as they appear in the judgment.
- Identify every Act and section materially cited.
- The headnote must be plain English and concise.
- The holding for each issue must be one clear sentence.
- The final order must state whether the matter was allowed, dismissed, partly allowed, remanded, etc., and the relief granted.
`;

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "judgment-speed-reader",
    models: MODELS
  });
});

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  let uploadedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No PDF was uploaded."
      });
    }

    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({
        error: "Please upload a PDF."
      });
    }

    uploadedPath = req.file.path;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured in Render."
      });
    }

    let lastError = null;

    for (const model of MODELS) {
      try {
        console.log(`Trying Gemini model: ${model}`);

        const uploadedFile = await ai.files.upload({
          file: uploadedPath,
          config: {
            mimeType: "application/pdf",
            displayName: req.file.originalname || "judgment.pdf"
          }
        });

        const response = await ai.models.generateContent({
          model,
          contents: [
            uploadedFile,
            ANALYSIS_PROMPT
          ],
          config: {
            responseMimeType: "application/json"
          }
        });

        const raw = response.text;

        if (!raw) {
          throw new Error("Gemini returned an empty response.");
        }

        let analysis;

        try {
          analysis = JSON.parse(raw);
        } catch {
          const cleaned = raw
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();

          analysis = JSON.parse(cleaned);
        }

        return res.json({
          success: true,
          model,
          analysis
        });

      } catch (error) {
        console.error(`Model ${model} failed:`, error.message);
        lastError = error;

        const message = String(error.message || "").toLowerCase();

        const shouldFallback =
          message.includes("429") ||
          message.includes("503") ||
          message.includes("overloaded") ||
          message.includes("unavailable") ||
          message.includes("resource exhausted") ||
          message.includes("rate limit") ||
          message.includes("capacity");

        if (!shouldFallback) {
          break;
        }
      }
    }

    return res.status(502).json({
      error: "Gemini could not analyze this judgment.",
      details: lastError ? lastError.message : "Unknown Gemini error."
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Analysis failed.",
      details: error.message
    });

  } finally {
    if (uploadedPath) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch {}
    }
  }
});

app.get('(.*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Judgment Speed Reader running on port ${PORT}`);
});
