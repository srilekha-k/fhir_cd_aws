import fs from "fs/promises";
import path from "path";

export type RagChunk = {
  id: string;
  fileName: string;
  chunk: string;
  embedding: number[];
};

// ✅ writable index path
const INDEX_PATH = process.env.RAG_INDEX_PATH || "/tmp/rag/index.json";

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadIndex(): Promise<RagChunk[]> {
  try {
    const data = await fs.readFile(INDEX_PATH, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveIndex(rows: RagChunk[]): Promise<void> {
  await ensureDir(INDEX_PATH);
  const tmp = INDEX_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, INDEX_PATH);
}
