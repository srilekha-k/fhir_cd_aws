import { Router, Request, Response } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

import { extractTextFromFile, chunkText } from "../utils/text.js";
import { embedMany, embedOne, cosine } from "../utils/embeddings.js";
import { loadIndex, saveIndex, RagChunk } from "../rag/store.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ writable upload dir
const uploadDir = process.env.UPLOAD_DIR || "/tmp/uploads";

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

async function embedInBatches(chunks: string[], batchSize = 32): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const slice = chunks.slice(i, i + batchSize);
    const vecs = await embedMany(slice);
    out.push(...vecs);
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

const router = Router();

// ---------- Upload ----------
router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const text = await extractTextFromFile(req.file.path, req.file.originalname);
    if (!text?.trim()) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: "Could not extract text from file" });
    }

    const chunks = chunkText(text, 350, 60);
    const embeddings = await embedInBatches(chunks, 32);

    const index = await loadIndex();
    const rows: RagChunk[] = chunks.map((chunk, i) => ({
      id: uuid(),
      fileName: req.file!.originalname,
      chunk,
      embedding: embeddings[i],
    }));
    await saveIndex([...index, ...rows]);

    await fs.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, fileName: req.file.originalname, chunks: rows.length });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Upload failed" });
  }
});

// ---------- Ask ----------
router.post("/ask", async (req: Request, res: Response) => {
  try {
    const { question, topK = 5, allowGeneral = true } = req.body || {};
    if (!question) return res.status(400).json({ error: "Missing question" });

    const qVec = await embedOne(question);
    const index = await loadIndex();
    if (index.length === 0) return res.status(400).json({ error: "No documents indexed yet" });

    const scored = index
      .map((row) => ({ row, score: cosine(qVec, row.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(topK, 10)));

    const context = scored
      .map((s, i) => `[[${i + 1}]] ${s.row.chunk}`)
      .join("\n\n")
      .slice(0, 12000);

    const rules = [
      "You are a medical assistant. Answer succinctly and factually in 4–8 sentences.",
      "Use the DOCUMENT CONTEXT as the primary source of truth.",
      allowGeneral
        ? "You MAY add general medical knowledge if it does not conflict with the documents."
        : "Do NOT use any knowledge outside the DOCUMENT CONTEXT.",
      "Cite statements grounded in the documents with [1], [2], etc.",
    ].join("\n");

    const prompt = `DOCUMENT CONTEXT:\n${context}\n\nQUESTION:\n${question}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: rules },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "";
    const sources = scored.map((s, i) => ({
      marker: `[${i + 1}]`,
      fileName: s.row.fileName,
      preview: s.row.chunk.slice(0, 180) + (s.row.chunk.length > 180 ? "…" : ""),
      score: Number(s.score.toFixed(3)),
    }));

    res.json({ answer, sources, usedGeneralKnowledge: Boolean(allowGeneral) });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Ask failed" });
  }
});

export default router;
