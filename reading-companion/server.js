import "dotenv/config";
import express from "express";
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "rc-data");
await mkdir(DATA_DIR, { recursive: true });

// Sanitize PDF filenames for use as file-system keys
const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

const readData = async (file) => {
  try { return JSON.parse(await readFile(join(DATA_DIR, sanitize(file)), "utf8")); }
  catch { return null; }
};

const writeData = async (file, data) =>
  writeFile(join(DATA_DIR, sanitize(file)), JSON.stringify(data), "utf8");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "10mb" })); // large payloads for screenshots

// API proxy to Anthropic
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY not set in .env" } });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Annotation store (JSON files under rc-data/)
app.get("/api/annotations/:filename", async (req, res) => {
  const data = await readData(`${req.params.filename}.ann.json`);
  res.json({ data: data ?? [] });
});

app.put("/api/annotations/:filename", async (req, res) => {
  try { await writeData(`${req.params.filename}.ann.json`, req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Cross-document full-text search across all annotation files
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  try {
    const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".ann.json"));
    const results = [];
    for (const file of files) {
      const anns = await readData(file);
      if (!Array.isArray(anns)) continue;
      const pdfName = file.slice(0, -".ann.json".length);
      for (const ann of anns) {
        const raw = (ann.rawText || "").toLowerCase();
        const firstAsst = ann.msgRoot?.children?.[0];
        const answer = typeof firstAsst?.content === "string" ? firstAsst.content : "";
        const answerLow = answer.toLowerCase();
        if (raw.includes(q) || answerLow.includes(q) || (ann.note || "").toLowerCase().includes(q)) {
          results.push({ pdfName, pageNum: ann.pageNum, rawText: ann.rawText || "", answer: answer.slice(0, 240), annId: ann.id });
          if (results.length >= 40) break;
        }
      }
      if (results.length >= 40) break;
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message, results: [] }); }
});

// All knowledge-log entries across all files (for knowledge graph generation)
app.get("/api/all-klogs", async (req, res) => {
  try {
    const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".klog.json"));
    const entries = [];
    for (const file of files) {
      const data = await readData(file);
      if (!Array.isArray(data)) continue;
      const pdfName = file.slice(0, -".klog.json".length);
      data.forEach((e) => entries.push({ ...e, pdfName }));
    }
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message, entries: [] }); }
});

// All research annotations across all files (for home screen Research Queue)
app.get("/api/all-research", async (req, res) => {
  try {
    const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".ann.json"));
    const entries = [];
    for (const file of files) {
      const data = await readData(file);
      if (!Array.isArray(data)) continue;
      const pdfName = file.slice(0, -".ann.json".length);
      data.filter((a) => a.type === "research").forEach((a) => entries.push({ ...a, pdfName }));
    }
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message, entries: [] }); }
});

// Project directory (groups of PDFs)
app.get("/api/projects", async (req, res) => {
  const data = await readData("projects.json");
  res.json({ projects: data ?? [] });
});

app.put("/api/projects", async (req, res) => {
  try { await writeData("projects.json", req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Knowledge log store
app.get("/api/klog/:filename", async (req, res) => {
  const data = await readData(`${req.params.filename}.klog.json`);
  res.json({ data: data ?? [] });
});

app.put("/api/klog/:filename", async (req, res) => {
  try { await writeData(`${req.params.filename}.klog.json`, req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// In production, serve the built frontend
if (process.env.NODE_ENV === "production") {
  app.use(express.static(join(__dirname, "dist")));
  app.get("*", (req, res) => {
    res.sendFile(join(__dirname, "dist", "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`\n  📖 Reading Companion server running at http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`  🔗 Open http://localhost:5173 for the dev server\n`);
  }
});
