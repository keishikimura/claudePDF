import "dotenv/config";
import express from "express";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
