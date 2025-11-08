import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import serverless from "@vendia/serverless-express";
import fs from "fs";            // ⬅️ use sync fs
import path from "path";

// --- route imports (compiled builds import .js)
import authRoutes from "./routes/auth.js";
import ragRoutes from "./routes/ragRoutes.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

// --- CORS allow-list
const allowed = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const apiGwRegex =
  /^https:\/\/[a-z0-9\-]+\.execute-api\.[a-z0-9\-]+\.amazonaws\.com$/i;
const fnUrlRegex =
  /^https:\/\/[a-z0-9\-]+\.lambda-url\.[a-z0-9\-]+\.on\.aws$/i;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.includes(origin) || apiGwRegex.test(origin) || fnUrlRegex.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);
app.options("*", cors());

// tiny logger
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// --- ensure writable /tmp folders on cold start (no top-level await)
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/uploads";
const RAG_PATH = process.env.RAG_INDEX_PATH || "/tmp/rag/index.json";
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(path.dirname(RAG_PATH), { recursive: true }); } catch {}

// --- MongoDB connection (cached across Lambda warm starts)
declare global {
  // eslint-disable-next-line no-var
  var __mongooseConnPromise: Promise<typeof mongoose> | undefined;
}

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Missing MONGO_URI");
  if (!global.__mongooseConnPromise) {
    global.__mongooseConnPromise = mongoose.connect(uri, {
      autoIndex: false,
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    } as any);
  }
  return global.__mongooseConnPromise;
}

// Connect once during cold start (no top-level await)
const mongoReady = connectMongo()
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection failed:", err));

// Optionally gate early requests on the initial connection
app.use(async (_req, _res, next) => {
  try { await mongoReady; } catch {}
  next();
});

// --- routes
app.use("/api/auth", authRoutes);
app.use("/api/rag", ragRoutes);

// --- health + root
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.type("text/plain").send("FHIR Chatbot API running. Try /health.")
);

// --- error handler (helps surface errors in CloudWatch)
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: err?.message || "Internal Server Error" });
});

// --- Wrap Express for AWS Lambda
const server = serverless({ app });
export const handler = (event: any, context: any) => server(event, context);
