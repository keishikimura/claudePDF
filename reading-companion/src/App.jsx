import { useState, useEffect, useRef, useCallback } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

const COLORS = {
  bg: "#F5F2EC", paper: "#FFFDF9", sidebar: "#F3F0EA", accent: "#C8842E",
  accentLight: "#FEF3C7", text: "#2C2417", textMuted: "#8C7E6E",
  border: "#E8E0D4", panelBg: "#FDFBF7", resolve: "#6B9E78",
};

const HL_COLORS = [
  { id: "yellow", bg: "rgba(251,191,36,0.28)", hover: "rgba(251,191,36,0.45)", dot: "#F59E0B" },
  { id: "green", bg: "rgba(74,180,120,0.25)", hover: "rgba(74,180,120,0.42)", dot: "#4AB478" },
  { id: "blue", bg: "rgba(96,165,250,0.25)", hover: "rgba(96,165,250,0.42)", dot: "#60A5FA" },
  { id: "pink", bg: "rgba(244,114,182,0.25)", hover: "rgba(244,114,182,0.42)", dot: "#F472B6" },
  { id: "orange", bg: "rgba(251,146,60,0.25)", hover: "rgba(251,146,60,0.42)", dot: "#FB923C" },
];

const getHlColor = (id) => HL_COLORS.find((c) => c.id === id) || HL_COLORS[0];
const RESEARCH_COLOR = { bg: "rgba(155,89,182,0.22)", hover: "rgba(155,89,182,0.38)", dot: "#9B59B6" };

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
const loadPdfJs = () =>
  new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const s = document.createElement("script");
    s.src = `${PDFJS_CDN}/pdf.min.js`;
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`; resolve(window.pdfjsLib); };
    s.onerror = reject;
    document.head.appendChild(s);
  });

// FIX 3: increased line-grouping tolerance (4→10px) and added 1px vertical padding
function mergeRects(clientRects, wrapperRect) {
  const raw = [];
  for (let i = 0; i < clientRects.length; i++) {
    const cr = clientRects[i];
    if (cr.width < 1 || cr.height < 1) continue;
    raw.push({ left: cr.left - wrapperRect.left, top: cr.top - wrapperRect.top, right: cr.right - wrapperRect.left, bottom: cr.bottom - wrapperRect.top });
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  let cur = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    // Compare against running group midpoint so early outliers don't anchor the group
    const curMid = cur.reduce((sum, r) => sum + (r.top + r.bottom) / 2, 0) / cur.length;
    if (Math.abs((raw[i].top + raw[i].bottom) / 2 - curMid) < 10) cur.push(raw[i]);
    else { lines.push(cur); cur = [raw[i]]; }
  }
  lines.push(cur);
  return lines.map((r) => {
    const l = Math.min(...r.map((x) => x.left));
    const t = Math.min(...r.map((x) => x.top));
    // 1px vertical padding ensures full character descenders are covered.
    // +3px right padding compensates for the scaleX approximation in the text layer
    // (item.width * cssScale vs item.str.length * fs * 0.52), which leaves highlights
    // a few pixels short of the visual right edge of the last character.
    return { left: l, top: t - 1, width: Math.max(...r.map((x) => x.right)) - l + 3, height: Math.max(...r.map((x) => x.bottom)) - t + 2 };
  });
}

/* ── Message tree helpers (Sprint 3) ── */
// Each node: { id, role, content, isError?, children: Node[] }
// The tree root is always the initial user message (auto-prompt).
// Branching: when a user creates a second follow-up from the same assistant node,
// that assistant node gets a second child — a new branch.

let _nodeIdCtr = 0;
const mkNodeId = () => `n-${Date.now()}-${++_nodeIdCtr}`;

function linearToTree(messages) {
  if (!messages || !messages.length) return null;
  const nodes = messages.map((m) => ({
    id: mkNodeId(), role: m.role, content: m.content, isError: m.isError || false, children: [],
  }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].children = [nodes[i + 1]];
  return nodes[0];
}

function findNode(root, nodeId) {
  if (!root) return null;
  if (root.id === nodeId) return root;
  for (const child of root.children) { const f = findNode(child, nodeId); if (f) return f; }
  return null;
}

function addNodeToTree(root, parentId, newNode) {
  if (!root) return newNode;
  const add = (n) => n.id === parentId
    ? { ...n, children: [...n.children, newNode] }
    : { ...n, children: n.children.map(add) };
  return add(root);
}

// Returns the sequence of nodes from root to the active leaf.
// At each fork (node with >1 child), follows activeBranchAt[nodeId] (default 0).
function getActivePath(root, activeBranchAt) {
  const path = [];
  let cur = root;
  while (cur) {
    path.push(cur);
    if (!cur.children.length) break;
    const idx = activeBranchAt?.[cur.id] ?? 0;
    cur = cur.children[Math.min(idx, cur.children.length - 1)];
  }
  return path;
}

// Flatten the active path into { role, content } objects for the Claude API.
// Returns an array of node IDs from root → targetId, or null if not found.
function getPathToNode(root, targetId) {
  if (!root) return null;
  if (root.id === targetId) return [root.id];
  for (const child of root.children) {
    const sub = getPathToNode(child, targetId);
    if (sub) return [root.id, ...sub];
  }
  return null;
}

// Skips error nodes so Claude doesn't see failed responses.
function getPathMessages(root, activeBranchAt) {
  return getActivePath(root, activeBranchAt)
    .filter((n) => !n.isError)
    .map(({ role, content }) => ({ role, content }));
}

function captureRegion(canvas, rects, dpr) {
  if (!canvas || !rects.length) return null;
  const pad = 8;
  const minX = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad);
  const minY = Math.max(0, Math.min(...rects.map((r) => r.top)) - pad);
  const maxX = Math.min(canvas.width / dpr, Math.max(...rects.map((r) => r.left + r.width)) + pad);
  const maxY = Math.min(canvas.height / dpr, Math.max(...rects.map((r) => r.top + r.height)) + pad);
  const w = (maxX - minX) * dpr, h = (maxY - minY) * dpr;
  if (w <= 0 || h <= 0) return null;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  tmp.getContext("2d").drawImage(canvas, minX * dpr, minY * dpr, w, h, 0, 0, w, h);
  return tmp.toDataURL("image/png").split(",")[1];
}

/* ── Citation detection (Sprint 5 A4) ── */
// Finds author-year citation spans in raw text extracted from a PDF.
// Handles both parenthetical — (Smith, 2020), (Smith & Jones, 2020a), (Smith et al., 2020) —
// and narrative styles — Smith (2020), Smith et al. (2020).
function detectCitations(text) {
  if (!text) return [];
  const found = new Set();
  // Parenthetical: (Smith, 2020) / (Smith & Jones, 2020a) / (Smith et al., 2020)
  const paren = /\([A-Z][a-zA-Z\u00C0-\u00FF\-]+(?: et al\.)?(?:(?:,? &|,? and) [A-Z][a-zA-Z\u00C0-\u00FF\-]+)*,? \d{4}[a-z]?\)/g;
  // Narrative: Smith (2020) / Smith et al. (2020)
  const narr = /[A-Z][a-zA-Z\u00C0-\u00FF\-]+(?: et al\.)? \(\d{4}[a-z]?\)/g;
  for (const m of text.matchAll(paren)) found.add(m[0]);
  for (const m of text.matchAll(narr)) found.add(m[0]);
  return [...found].slice(0, 12);
}

/* ── Storage via localStorage ── */
const storageKey = (name) => `rc:${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

const sanitizeForUrl = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

function saveAnnotations(fileName, annotations) {
  try {
    const data = annotations.map(({ screenshot, loading, ...rest }) => rest);
    localStorage.setItem(storageKey(fileName), JSON.stringify(data));
    // Async backup to server (fire-and-forget; silently skipped if server unreachable)
    fetch(`/api/annotations/${sanitizeForUrl(fileName)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }).catch(() => {});
  } catch (e) { console.warn("Save failed:", e); }
}

function loadAnnotationsFromStorage(fileName) {
  try {
    const raw = localStorage.getItem(storageKey(fileName));
    if (raw) {
      return JSON.parse(raw).map((ann) => {
        // Migrate old linear-array format to tree format
        if (ann.messages && !ann.msgRoot) {
          const { messages, ...rest } = ann;
          return { ...rest, msgRoot: linearToTree(messages), activeBranchAt: {} };
        }
        return ann;
      });
    }
  } catch { /* empty */ }
  return [];
}

/* ── IndexedDB PDF Cache ── */
// Stores PDF ArrayBuffers so history items can reopen without a file picker.
const IDB_NAME = "rc-pdfs";
const IDB_STORE = "pdfs";

function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = (e) => res(e.target.result);
    req.onerror = () => rej(req.error);
  });
}

async function savePdfIDB(name, buffer) {
  try {
    const db = await openIDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(buffer, name);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn("IDB save failed:", e); }
}

async function loadPdfIDB(name) {
  try {
    const db = await openIDB();
    return await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(name);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  } catch { return null; }
}

/* ── File history ── */
const HISTORY_KEY = "rc:history";

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function upsertHistory(name, annotationCount = 0) {
  const next = [{ name, lastOpened: Date.now(), annotationCount }, ...loadHistory().filter((h) => h.name !== name)].slice(0, 20);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* quota */ }
  return next;
}

function removeFromHistory(name) {
  const next = loadHistory().filter((h) => h.name !== name);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* quota */ }
  return next;
}

function formatAge(ts) {
  const ms = Date.now() - ts;
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  if (ms < 604800000) return `${Math.floor(ms / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

/* ── Models ── */
const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku",  short: "H", desc: "Fast · lower cost" },
  { id: "claude-sonnet-4-6",         label: "Sonnet", short: "S", desc: "Balanced" },
  { id: "claude-opus-4-6",           label: "Opus",   short: "O", desc: "Most capable" },
];

const READING_MODES = [
  { id: "general",  label: "General",  short: "G", desc: "Clear, concise explanations" },
  { id: "academic", label: "Academic", short: "A", desc: "Critical analysis — claims, evidence, gaps" },
  { id: "newcomer", label: "Simple",   short: "S", desc: "Plain language, beginner-friendly" },
];

/* ── Adaptive context (items 19+20) ── */
// Classifies a follow-up question as general knowledge or paper-specific.
// Paper-specific questions get full document context; general ones get a narrow slice.
// Defaults to "specific" (safe fallback — never withhold context when uncertain).
const PAPER_REF_RE = /\b(the (?:authors?|paper|article|study|text|section|figure|table|method|model|framework|results?|dataset|experiment|approach|algorithm|equation|theorem|definition|chapter|abstract|introduction|conclusion)|they|their|this work|in section|fig\.|eq\.|et al\.?|according to)\b/i;
function classifyQuestion(msg) {
  if (!msg || msg.length > 300) return "specific";
  if (PAPER_REF_RE.test(msg)) return "specific";
  if (/^(?:what(?:'s| is| are)|how (?:does|do|can)|explain|define|why is|what does|what do|can you explain)\b/i.test(msg)) return "general";
  return "specific";
}

/* ── API via local proxy ── */
const callClaude = async (systemPrompt, messages, model) => {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || MODELS[1].id,
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `API error ${res.status}`);
  }

  return data.content?.map((b) => b.text || "").join("\n") || "No response.";
};

const buildSystemPrompt = (pageTexts, annotations, focusPage, mode = "general", maxDocChars = 30000) => {
  const MAX = maxDocChars;
  const order = [];
  if (focusPage) { order.push(focusPage - 1); if (focusPage >= 2) order.push(focusPage - 2); if (focusPage < pageTexts.length) order.push(focusPage); }
  for (let i = 0; i < pageTexts.length; i++) if (!order.includes(i)) order.push(i);
  let doc = "", chars = 0; const inc = new Set();
  for (const idx of order) { const e = `\n[Page ${idx + 1}]\n${pageTexts[idx] || ""}\n`; if (chars + e.length > MAX && inc.size > 0) break; doc += e; chars += e.length; inc.add(idx); }
  const trunc = inc.size < pageTexts.length ? `\n[${pageTexts.length} pages, ${inc.size} shown.]` : "";
  // Use tree model for prior Q&A context (msgRoot, not legacy messages array)
  const qa = annotations
    .filter((a) => a.type === "claude" && a.msgRoot?.children?.length > 0)
    .slice(-5)
    .map((a) => {
      const firstAsst = a.msgRoot?.children?.[0];
      const answerText = typeof firstAsst?.content === "string" ? firstAsst.content : "";
      return `Q (p.${a.pageNum}): "${a.rawText?.slice(0, 80)}"\nA: ${answerText.slice(0, 200)}`;
    })
    .join("\n\n");

  const basePrompt = mode === "academic"
    ? `You are a rigorous academic reading companion. The reader is engaged in critical scholarly analysis.

For each highlighted passage:
- State the core claim or argument being made
- Identify the evidence, reasoning, or data provided to support it
- Surface any assumptions left implicit or unstated
- Flag logical leaps, undefined terms, vague hedging, or unsupported generalizations
- Note how this passage connects to the broader argument of the document

Be precise and analytical. Match the vocabulary of the discipline. Do not over-explain; assume the reader is at graduate or expert level. You receive a screenshot (use as primary source) and raw extracted text (may be garbled for math).`
    : mode === "newcomer"
      ? `You are a patient, accessible reading companion helping someone new to this subject.

For each highlighted passage:
- Begin with the core idea in one plain sentence
- Use everyday analogies to make abstract concepts tangible
- Avoid jargon; if a technical term is essential, define it immediately in simple terms
- Keep the initial response short (2-4 sentences); expand only if asked

Your goal is to make the reader feel confident and curious, not overwhelmed. You receive a screenshot (use as primary source) and raw extracted text (may be garbled for math).`
      : `You are a reading companion. The user highlights confusing passages. You receive a screenshot + raw extracted text (may be garbled for math). Use the screenshot as primary source. Be concise (2-4 sentences) initially, thorough in follow-ups.`;

  return `${basePrompt}

DOCUMENT:${doc}${trunc}
${qa ? `\nPRIOR Q&A:\n${qa}` : ""}`;
};

/* ── Markdown renderer ── */
// Finds the leftmost-starting inline pattern (code > bold > italic) and renders it.
function renderKatex(latex, displayMode, key) {
  try {
    const html = katex.renderToString(latex, { throwOnError: false, displayMode });
    return <span key={key} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch { return <span key={key}>{displayMode ? `$$${latex}$$` : `$${latex}$`}</span>; }
}

function inlineMarkdown(text, baseKey = 0) {
  const patterns = [
    { re: /`([^`]+)`/,       wrap: (m, k) => <code key={k} style={{ background: "#f0ede6", borderRadius: 3, padding: "1px 5px", fontSize: "0.88em", fontFamily: "monospace" }}>{m[1]}</code> },
    { re: /\*\*([^*]+)\*\*/, wrap: (m, k) => <strong key={k}>{m[1]}</strong> },
    { re: /\*([^*]+)\*/,     wrap: (m, k) => <em key={k}>{m[1]}</em> },
    { re: /\$([^$\n]+)\$/,   wrap: (m, k) => renderKatex(m[1], false, k) },
  ];
  const segments = [];
  let remaining = text, key = baseKey;
  while (remaining.length) {
    let best = null, bestIdx = Infinity, bestPat = null;
    for (const p of patterns) {
      const m = remaining.match(p.re);
      if (m && m.index < bestIdx) { best = m; bestIdx = m.index; bestPat = p; }
    }
    if (!best) { segments.push(remaining); break; }
    if (bestIdx > 0) segments.push(remaining.slice(0, bestIdx));
    segments.push(bestPat.wrap(best, key++));
    remaining = remaining.slice(bestIdx + best[0].length);
  }
  return segments.length === 1 && typeof segments[0] === "string" ? segments[0] : segments;
}

function Markdown({ text }) {
  if (!text) return null;
  const elements = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Display math block $$...$$
    if (line.trimStart().startsWith("$$")) {
      const rest = line.trimStart().slice(2);
      if (rest.trimEnd().endsWith("$$") && rest.trim().length > 2) {
        // Single-line: $$formula$$
        elements.push(<div key={elements.length} style={{ overflowX: "auto", margin: "10px 0", textAlign: "center" }}>{renderKatex(rest.trimEnd().slice(0, -2), true, elements.length)}</div>);
        i++; continue;
      }
      // Multi-line: $$\n...\n$$
      const mathLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("$$")) { mathLines.push(lines[i]); i++; }
      elements.push(<div key={elements.length} style={{ overflowX: "auto", margin: "10px 0", textAlign: "center" }}>{renderKatex(mathLines.join("\n"), true, elements.length)}</div>);
      i++; continue;
    }
    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) { codeLines.push(lines[i]); i++; }
      elements.push(<pre key={elements.length} style={{ background: COLORS.bg, borderRadius: 6, padding: "10px 14px", overflowX: "auto", fontSize: 13, lineHeight: 1.5, margin: "8px 0", fontFamily: "monospace", whiteSpace: "pre" }}>{codeLines.join("\n")}</pre>);
      i++; continue;
    }
    // Unordered list
    if (/^[-*+] /.test(line.trimStart())) {
      const items = [];
      while (i < lines.length && /^[-*+] /.test(lines[i].trimStart())) {
        items.push(<li key={i} style={{ marginBottom: 2 }}>{inlineMarkdown(lines[i].replace(/^[-*+] /, ""), i * 100)}</li>);
        i++;
      }
      elements.push(<ul key={elements.length} style={{ paddingLeft: 20, margin: "4px 0 8px" }}>{items}</ul>);
      continue;
    }
    // Numbered list
    if (/^\d+\. /.test(line.trimStart())) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i].trimStart())) {
        items.push(<li key={i} style={{ marginBottom: 2 }}>{inlineMarkdown(lines[i].replace(/^\d+\. /, ""), i * 100)}</li>);
        i++;
      }
      elements.push(<ol key={elements.length} style={{ paddingLeft: 20, margin: "4px 0 8px" }}>{items}</ol>);
      continue;
    }
    // Headings
    const hMatch = line.match(/^(#{1,4}) (.+)/);
    if (hMatch) {
      const sizes = [18, 16, 15, 14];
      const lvl = Math.min(hMatch[1].length - 1, 3);
      elements.push(<div key={elements.length} style={{ fontSize: sizes[lvl], fontWeight: 700, margin: "12px 0 6px", color: COLORS.text }}>{inlineMarkdown(hMatch[2], i * 100)}</div>);
      i++; continue;
    }
    // Empty line → spacing
    if (!line.trim()) { elements.push(<div key={elements.length} style={{ height: 6 }} />); i++; continue; }
    // Paragraph
    elements.push(<div key={elements.length} style={{ marginBottom: 4, lineHeight: 1.7 }}>{inlineMarkdown(line, i * 100)}</div>);
    i++;
  }
  return <>{elements}</>;
}

/* ── Selection Toolbar ── */
function SelectionToolbar({ rect, selectedColor, onColorChange, onHighlight, onAskClaude, onAddResearch }) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [researchMode, setResearchMode] = useState(false);
  const [researchQ, setResearchQ] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const l = Math.max(8, Math.min(rect.left + rect.width / 2 - 110, window.innerWidth - 280));
    const above = rect.top - 52;
    setPos({ top: above > 8 ? above : rect.bottom + 8, left: l });
  }, [rect]);

  useEffect(() => {
    if (researchMode) inputRef.current?.focus();
  }, [researchMode]);

  const toolbarBase = {
    position: "fixed", top: pos.top, left: pos.left, zIndex: 1001,
    display: "flex", alignItems: "center", gap: 4, padding: "6px 10px",
    background: "#fff", borderRadius: 10,
    boxShadow: "0 4px 20px rgba(44,36,23,0.16), 0 1px 4px rgba(44,36,23,0.08)",
    border: `1px solid ${COLORS.border}`, animation: "popIn 0.15s ease-out",
  };

  if (researchMode) {
    const submit = () => { if (researchQ.trim()) { onAddResearch(researchQ.trim()); setResearchMode(false); setResearchQ(""); } };
    return (
      <div data-toolbar style={{ ...toolbarBase, minWidth: 300 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#9B59B6", letterSpacing: "0.04em", marginRight: 2 }}>?</span>
        <input ref={inputRef} value={researchQ} onChange={(e) => setResearchQ(e.target.value)}
          placeholder="Research question…"
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setResearchMode(false); setResearchQ(""); } }}
          style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: `1px solid ${COLORS.border}`, fontSize: 13, color: COLORS.text, outline: "none", background: COLORS.paper, fontFamily: "'DM Sans', sans-serif" }} />
        <button onClick={submit} disabled={!researchQ.trim()}
          style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: researchQ.trim() ? "#9B59B6" : COLORS.border, color: "#fff", cursor: researchQ.trim() ? "pointer" : "default", fontSize: 12, fontWeight: 600 }}>✓</button>
        <button onClick={() => { setResearchMode(false); setResearchQ(""); }}
          style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, cursor: "pointer", fontSize: 12 }}>✕</button>
      </div>
    );
  }

  return (
    <div data-toolbar style={toolbarBase}>
      {HL_COLORS.map((c) => (
        <button key={c.id} onClick={() => onColorChange(c.id)}
          style={{
            width: 20, height: 20, borderRadius: "50%",
            border: selectedColor === c.id ? `2px solid ${c.dot}` : "2px solid transparent",
            background: c.dot, cursor: "pointer", padding: 0,
            boxShadow: selectedColor === c.id ? `0 0 0 2px ${COLORS.paper}` : "none",
          }} />
      ))}
      <div style={{ width: 1, height: 20, background: COLORS.border, margin: "0 4px" }} />
      <button onClick={onHighlight} title="Highlight (H)"
        style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${COLORS.border}`, background: COLORS.paper, cursor: "pointer", fontSize: 12, fontWeight: 600, color: COLORS.text }}>
        H
      </button>
      <button onClick={onAskClaude} title="Ask Claude (C)"
        style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: COLORS.accent, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#fff" }}>
        C
      </button>
      <button onClick={() => setResearchMode(true)} title="Add research question (R)"
        style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: "#9B59B6", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#fff" }}>
        R
      </button>
    </div>
  );
}

/* ── Highlight Overlay ── */
function HighlightOverlay({ annotations, pageNum, onClickAnnotation, pageDims }) {
  const anns = annotations.filter((a) => a.pageNum === pageNum && a.mergedRects?.length > 0);
  if (!anns.length) return null;

  // Un-normalize rects from [0,1] page fractions back to CSS pixels using current page dims.
  // Returns null if we can't safely compute pixel positions (avoids rendering at [0,1] coords).
  const toPixels = (r, ann) => {
    if (!ann.normalized) return r;
    if (!pageDims) return null; // page not yet painted at current scale — skip rendering
    return { left: r.left * pageDims.w, top: r.top * pageDims.h, width: r.width * pageDims.w, height: r.height * pageDims.h };
  };

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}>
      {anns.map((ann) => {
        const c = ann.type === "research"
          ? RESEARCH_COLOR
          : ann.type === "claude" && ann.status === "resolved"
            ? { bg: "rgba(107,158,120,0.22)", hover: "rgba(107,158,120,0.38)" }
            : getHlColor(ann.color);
        return ann.mergedRects.map((r, i) => {
          const px = toPixels(r, ann);
          if (!px) return null; // pageDims not ready yet — skip rather than misplace
          return (
            <div key={`${ann.id}-${i}`}
              onClick={(e) => { e.stopPropagation(); onClickAnnotation(ann.id); }}
              style={{ position: "absolute", left: px.left, top: px.top, width: px.width, height: px.height, backgroundColor: c.bg, cursor: "pointer", pointerEvents: "auto", borderRadius: 3, transition: "background-color 0.15s" }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = c.hover}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = c.bg}
            />
          );
        });
      })}
    </div>
  );
}

/* ── PDF Page ── */
// FIX 1: Virtual rendering — only paint canvas when near viewport.
// Phase 1 (dims): runs immediately for all pages — cheap getViewport call, no canvas work.
//   Gives each page its correct placeholder height so scroll math works.
// Phase 2 (observe): IntersectionObserver fires once when page enters viewport (+500px margin).
// Phase 3 (render): canvas + text layer rendered only after Phase 2 fires.
//   Once rendered, stays rendered even when scrolled past (avoids re-render churn).
//   Zoom/containerWidth changes re-run Phase 3 for already-rendered pages automatically.
function PdfPage({ pdf, pageNum, containerWidth, zoom, annotations, onClickAnnotation, drawMode }) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const [dims, setDims] = useState(null);
  // renderDims is only updated AFTER Phase 3 finishes painting the canvas.
  // Highlights use renderDims so they never jump ahead of the canvas render.
  const [renderDims, setRenderDims] = useState(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [hasText, setHasText] = useState(true); // optimistic; updated after Phase 3
  const dprRef = useRef(window.devicePixelRatio || 1);

  // Phase 1: measure page dimensions without touching canvas
  useEffect(() => {
    if (!containerWidth || containerWidth <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const baseVp = page.getViewport({ scale: 1 });
        const cssScale = (containerWidth - 48) / baseVp.width * zoom;
        const cssVp = page.getViewport({ scale: cssScale });
        // Only resize the wrapper — do NOT touch renderDims yet.
        // Highlights stay at old renderDims until Phase 3 finishes painting.
        if (!cancelled) setDims({ w: cssVp.width, h: cssVp.height });
      } catch (e) { console.error(`Dims page ${pageNum}:`, e); }
    })();
    return () => { cancelled = true; };
  }, [pdf, pageNum, containerWidth, zoom]);

  // Phase 2: enable rendering once the placeholder enters the viewport
  useEffect(() => {
    if (!wrapperRef.current) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setShouldRender(true); },
      { rootMargin: "500px 0px" }
    );
    obs.observe(wrapperRef.current);
    return () => obs.disconnect();
  }, []);

  // Phase 3: paint canvas + build text layer
  useEffect(() => {
    if (!shouldRender || !containerWidth || containerWidth <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const baseVp = page.getViewport({ scale: 1 });
        const cssScale = (containerWidth - 48) / baseVp.width * zoom;
        const dpr = window.devicePixelRatio || 1;
        dprRef.current = dpr;
        const vp = page.getViewport({ scale: cssScale * dpr });
        const cssVp = page.getViewport({ scale: cssScale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = cssVp.width + "px"; canvas.style.height = cssVp.height + "px";
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        if (cancelled) return;
        const tc = await page.getTextContent();
        const tl = textLayerRef.current;
        if (!tl || cancelled) return;
        tl.innerHTML = ""; tl.style.width = cssVp.width + "px"; tl.style.height = cssVp.height + "px";
        tc.items.forEach((item) => {
          if (!item.str?.trim()) return;
          const tx = window.pdfjsLib.Util.transform(cssVp.transform, item.transform);
          const span = document.createElement("span");
          span.textContent = item.str;
          const fs = Math.sqrt(tx[0] ** 2 + tx[1] ** 2);
          let scaleX = 1;
          if (item.width && item.str.length > 0 && fs > 0) { const mw = item.str.length * fs * 0.52; if (mw > 0) scaleX = (item.width * cssScale) / mw; }
          // Use 0.85 ascent ratio so spans sit at the actual glyph position on the canvas,
          // not 0.15×fs above it (which caused highlights to appear above the text).
          // Explicit height keeps adjacent lines from overlapping their hit areas.
          span.style.cssText = `position:absolute;left:${tx[4]}px;top:${tx[5] - fs * 0.85}px;height:${fs}px;font-size:${fs}px;font-family:sans-serif;transform-origin:0 100%;transform:scaleX(${scaleX}) rotate(${Math.atan2(tx[1], tx[0])}rad);color:transparent;white-space:pre;cursor:text;line-height:1;`;
          tl.appendChild(span);
        });
        // Canvas + text layer are fully painted at this scale — safe to reposition highlights.
        if (!cancelled) {
          setRenderDims({ w: cssVp.width, h: cssVp.height });
          setHasText(tc.items.filter((it) => it.str.trim()).length > 0);
        }
      } catch (e) { console.error(`Render page ${pageNum}:`, e); }
    })();
    return () => { cancelled = true; };
  }, [shouldRender, pdf, pageNum, containerWidth, zoom]);

  return (
    <div ref={wrapperRef} data-page={pageNum}
      style={{ position: "relative", marginBottom: 16, boxShadow: "0 2px 12px rgba(44,36,23,0.08)", borderRadius: 4, overflow: "hidden", width: dims?.w || "100%", height: dims?.h || 400, background: "#fff", flexShrink: 0 }}>
      {!shouldRender && (
        <div style={{ position: "absolute", inset: 0, background: COLORS.paper, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: COLORS.textMuted, fontSize: 12 }}>Page {pageNum}</span>
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div ref={textLayerRef} style={{ position: "absolute", top: 0, left: 0, overflow: "hidden", opacity: 0.3, lineHeight: 1, zIndex: 1 }} />
      <HighlightOverlay annotations={annotations} pageNum={pageNum} onClickAnnotation={onClickAnnotation} pageDims={renderDims} />
      <div style={{ position: "absolute", top: 8, right: 12, fontSize: 11, color: COLORS.textMuted, background: "rgba(255,253,249,0.85)", padding: "2px 8px", borderRadius: 4, zIndex: 3, userSelect: "none" }}>{pageNum}</div>
      {!hasText && !drawMode && shouldRender && (
        <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", zIndex: 4, background: "rgba(155,89,182,0.10)", border: "1px solid rgba(155,89,182,0.28)", borderRadius: 6, padding: "4px 12px", fontSize: 11, color: "#9B59B6", pointerEvents: "none", whiteSpace: "nowrap" }}>
          No selectable text · Use Draw mode to select regions
        </div>
      )}
    </div>
  );
}

/* ── Thumbnail Strip ── */

// thumbWidth is the CSS pixel width of each thumbnail image (dynamic based on strip width)
function ThumbnailPage({ pdf, pageNum, isActive, onClick, thumbWidth }) {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const [rendered, setRendered] = useState(false);

  // Lazy render: only paint when the thumbnail enters the strip's scroll viewport
  useEffect(() => {
    if (!wrapperRef.current) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) setRendered(true); },
      { rootMargin: "600px 0px" }
    );
    obs.observe(wrapperRef.current);
    return () => obs.disconnect();
  }, []);

  // Re-renders whenever thumbWidth changes (strip resized)
  useEffect(() => {
    if (!rendered || !thumbWidth) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const baseVp = page.getViewport({ scale: 1 });
        const cssScale = thumbWidth / baseVp.width;
        const cssH = Math.round(baseVp.height * cssScale);
        const renderVp = page.getViewport({ scale: cssScale * dpr });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = renderVp.width; canvas.height = renderVp.height;
        canvas.style.width = `${thumbWidth}px`; canvas.style.height = `${cssH}px`;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: renderVp }).promise;
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [rendered, pdf, pageNum, thumbWidth]);

  const thumbH = Math.round((thumbWidth || 80) * 1.414); // A4 aspect ratio placeholder

  return (
    <div ref={wrapperRef} data-thumb={pageNum} onClick={onClick}
      style={{ margin: "0 auto 6px", cursor: "pointer", flexShrink: 0, width: thumbWidth }}>
      {/* Border lives on the image container so it hugs the page, not the label */}
      <div style={{
        width: thumbWidth, minHeight: thumbH,
        background: COLORS.paper, borderRadius: 2, overflow: "hidden",
        boxShadow: isActive
          ? `0 0 0 2px ${COLORS.accent}, 0 2px 6px rgba(44,36,23,0.12)`
          : "0 1px 4px rgba(44,36,23,0.08)",
        transition: "box-shadow 0.12s",
      }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.boxShadow = `0 0 0 1px ${COLORS.border}, 0 2px 6px rgba(44,36,23,0.1)`; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.boxShadow = "0 1px 4px rgba(44,36,23,0.08)"; }}>
        {rendered && <canvas ref={canvasRef} style={{ display: "block" }} />}
      </div>
      <div style={{ fontSize: 10, color: isActive ? COLORS.accent : COLORS.textMuted, textAlign: "center", paddingTop: 3, fontWeight: isActive ? 600 : 400 }}>{pageNum}</div>
    </div>
  );
}

function ThumbnailStrip({ pdf, numPages, currentPage, onJumpToPage, width, onResizeDrag, onClose }) {
  const stripRef = useRef(null);
  const thumbWidth = Math.max(56, width - 24); // leave 12px padding each side

  // Scroll the active thumbnail into view as the user navigates the PDF
  useEffect(() => {
    if (!stripRef.current) return;
    const el = stripRef.current.querySelector(`[data-thumb="${currentPage}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentPage]);

  return (
    <div style={{ position: "relative", width, flexShrink: 0, display: "flex", flexDirection: "column", background: COLORS.sidebar, borderRight: `1px solid ${COLORS.border}` }}>
      {/* Strip header */}
      <div style={{ padding: "8px 10px 6px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: COLORS.textMuted, textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>Pages</span>
        <button onClick={onClose} title="Hide thumbnails"
          style={{ fontSize: 13, lineHeight: 1, background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: "0 2px" }}
          onMouseEnter={(e) => e.currentTarget.style.color = COLORS.text}
          onMouseLeave={(e) => e.currentTarget.style.color = COLORS.textMuted}>×</button>
      </div>
      {/* Thumbnail list */}
      <div ref={stripRef} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", paddingTop: 8, paddingBottom: 8 }}>
        {Array.from({ length: numPages }, (_, i) => i + 1).map((num) => (
          <ThumbnailPage key={num} pdf={pdf} pageNum={num} isActive={num === currentPage}
            onClick={() => onJumpToPage(num)} thumbWidth={thumbWidth} />
        ))}
      </div>
      {/* Drag handle on right edge */}
      <div onMouseDown={onResizeDrag}
        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 5, cursor: "col-resize", zIndex: 10, background: "transparent", transition: "background 0.15s" }}
        onMouseEnter={(e) => e.currentTarget.style.background = "rgba(200,132,46,0.25)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"} />
    </div>
  );
}

/* ── Popover ── */
function Popover({ rect, annotation, onExpand, onResolve }) {
  const [pos, setPos] = useState({ top: 0, left: 0, transform: "none" });
  useEffect(() => {
    const l = Math.max(12, Math.min(rect.left, window.innerWidth - 400));
    setPos(window.innerHeight - rect.bottom < 300
      ? { top: rect.top - 8, left: l, transform: "translateY(-100%)" }
      : { top: rect.bottom + 8, left: l, transform: "none" });
  }, [rect]);
  const activePath = annotation?.msgRoot ? getActivePath(annotation.msgRoot, annotation.activeBranchAt) : [];
  const hasResp = activePath.length > 1;
  const loading = annotation?.loading;
  const lastA = [...activePath].reverse().find((n) => n.role === "assistant");
  const isErr = lastA?.isError || false;
  return (
    <div data-popover style={{
      position: "fixed", top: pos.top, left: pos.left, transform: pos.transform,
      width: 380, zIndex: 1000, background: COLORS.panelBg, borderRadius: 12,
      boxShadow: "0 8px 32px rgba(44,36,23,0.18), 0 2px 8px rgba(44,36,23,0.08)",
      border: `1px solid ${COLORS.border}`, overflow: "hidden", animation: "popIn 0.2s ease-out",
    }}>
      {annotation?.screenshot && (
        <div style={{ padding: "10px 16px 6px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.accentLight }}>
          <img src={`data:image/png;base64,${annotation.screenshot}`} style={{ maxWidth: "100%", maxHeight: 80, borderRadius: 4, display: "block" }} alt="" />
        </div>
      )}
      <div style={{ padding: "12px 16px", minHeight: 48, maxHeight: 240, overflow: "auto" }}>
        {loading ? <div style={{ color: COLORS.textMuted, fontSize: 14 }}><span className="loading-dots">Thinking</span></div>
          : hasResp ? (isErr
            ? <div style={{ fontSize: 14, lineHeight: 1.7, color: "#991B1B", whiteSpace: "pre-wrap", background: "#FEE2E2", padding: "8px 10px", borderRadius: 6 }}>{lastA?.content}</div>
            : <div style={{ fontSize: 14, color: COLORS.text }}><Markdown text={lastA?.content} /></div>)
          : <div style={{ color: COLORS.textMuted, fontSize: 14 }}>Asking Claude…</div>}
      </div>
      {hasResp && !loading && !isErr && (
        <div style={{ display: "flex", borderTop: `1px solid ${COLORS.border}`, fontSize: 13 }}>
          <button onClick={onResolve} style={{ flex: 1, padding: "10px", background: "none", border: "none", cursor: "pointer", color: COLORS.resolve, fontWeight: 600 }}
            onMouseEnter={(e) => e.currentTarget.style.background = "rgba(107,158,120,0.08)"}
            onMouseLeave={(e) => e.currentTarget.style.background = "none"}>✓ Got it</button>
          <div style={{ width: 1, background: COLORS.border }} />
          <button onClick={onExpand} style={{ flex: 1, padding: "10px", background: "none", border: "none", cursor: "pointer", color: COLORS.accent, fontWeight: 600 }}
            onMouseEnter={(e) => e.currentTarget.style.background = "rgba(200,132,46,0.08)"}
            onMouseLeave={(e) => e.currentTarget.style.background = "none"}>Dig deeper →</button>
        </div>
      )}
    </div>
  );
}

/* ── Tree view node (recursive) — used by DetailPanel in tree mode ── */
function TreeNode({ node, depth, activePathIds, onSelectNode }) {
  const isActive = activePathIds.has(node.id);
  const isAssistant = node.role === "assistant";
  const textPreview = typeof node.content === "string"
    ? node.content
    : node.content?.find?.((b) => b.type === "text")?.text || "";
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div
        onClick={() => !isActive && onSelectNode(node.id)}
        style={{
          opacity: isActive ? 1 : 0.5,
          cursor: isActive ? "default" : "pointer",
          marginBottom: 6,
          paddingLeft: 8,
          borderLeft: `2px solid ${isActive ? (isAssistant ? COLORS.textMuted : COLORS.accent) : COLORS.border}`,
          transition: "opacity 0.12s",
        }}
        title={isActive ? undefined : "Click to switch to this branch"}
      >
        <div style={{ fontSize: 10, fontWeight: 600, color: isAssistant ? COLORS.textMuted : COLORS.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>
          {isAssistant ? "Claude" : "You"}
        </div>
        {isAssistant && !node.isError
          ? <div style={{ fontSize: 13, color: COLORS.text }}><Markdown text={textPreview.slice(0, 180) + (textPreview.length > 180 ? "…" : "")} /></div>
          : <div style={{ fontSize: 13, color: node.isError ? "#991B1B" : COLORS.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {textPreview.slice(0, 180)}{textPreview.length > 180 ? "…" : ""}
            </div>}
      </div>
      {node.children.map((child) => (
        <TreeNode key={child.id} node={child} depth={depth + 1}
          activePathIds={activePathIds} onSelectNode={onSelectNode} />
      ))}
    </div>
  );
}

/* ── Detail Panel ── */
function DetailPanel({ annotation, onSend, onBranchSelect, onSetFullActiveBranch, onResolve, onClose, onDelete, onNoteChange, loggedNodeIds, onToggleLog }) {
  const [input, setInput] = useState("");
  // null = reply at end of active path; string = ID of the specific assistant node to branch from
  const [replyToNodeId, setReplyToNodeId] = useState(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [viewMode, setViewMode] = useState("tab"); // "tab" | "tree"
  const chatRef = useRef(null);
  const inputRef = useRef(null);

  const activePath = annotation?.msgRoot
    ? getActivePath(annotation.msgRoot, annotation.activeBranchAt)
    : [];

  // Set of active-path node IDs — used by TreeNode to know which are active
  const activePathIds = new Set(activePath.map((n) => n.id));

  // In tree mode: clicking an inactive node re-routes activeBranchAt so that node becomes active.
  const selectTreeNode = (targetId) => {
    if (!annotation.msgRoot || !onSetFullActiveBranch) return;
    const pathIds = getPathToNode(annotation.msgRoot, targetId);
    if (!pathIds) return;
    const newBranchAt = { ...annotation.activeBranchAt };
    for (let i = 0; i < pathIds.length - 1; i++) {
      const n = findNode(annotation.msgRoot, pathIds[i]);
      const nextId = pathIds[i + 1];
      const childIdx = n.children.findIndex((c) => c.id === nextId);
      if (childIdx !== -1) newBranchAt[n.id] = childIdx;
    }
    onSetFullActiveBranch(newBranchAt);
  };

  // Scroll chat to bottom when new nodes arrive
  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [activePath.length]);

  useEffect(() => { inputRef.current?.focus(); }, [annotation?.id]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // When branch changes, clear the replyTo context (it may no longer apply)
  useEffect(() => { setReplyToNodeId(null); }, [annotation?.activeBranchAt]);

  if (!annotation) return null;

  const isClaude = annotation.type === "claude";
  const isResearch = annotation.type === "research";
  const hlColor = isResearch ? RESEARCH_COLOR : getHlColor(annotation.color);

  // Determine parent node for the next send
  const lastAssistantInPath = [...activePath].reverse().find((n) => n.role === "assistant");
  const sendParentId = replyToNodeId || lastAssistantInPath?.id || annotation.msgRoot?.id;
  const replyToNode = replyToNodeId ? findNode(annotation.msgRoot, replyToNodeId) : null;

  const send = () => {
    if (!input.trim() || !sendParentId) return;
    onSend(sendParentId, input.trim());
    setInput("");
    setReplyToNodeId(null);
  };

  // visibleNodes: skip the root (auto-prompt user message, index 0)
  const visibleNodes = activePath.slice(1);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.panelBg }}>
      {/* Header */}
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: hlColor.dot, flexShrink: 0 }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: isResearch ? "#9B59B6" : COLORS.accent, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {isClaude ? "Thread" : isResearch ? "Research Q" : "Note"} · Page {annotation.pageNum}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {isClaude && annotation.status !== "resolved" && (
            <button onClick={onResolve} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: `1px solid ${COLORS.resolve}`, background: "none", color: COLORS.resolve, cursor: "pointer", fontWeight: 600 }}>✓</button>
          )}
          {/* Tab / Tree view toggle — only shown for Claude annotations with branches */}
          {isClaude && (
            <button onClick={() => setViewMode((v) => v === "tab" ? "tree" : "tab")}
              title={viewMode === "tab" ? "Switch to tree view" : "Switch to tab view"}
              style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: `1px solid ${COLORS.border}`, background: viewMode === "tree" ? COLORS.accentLight : "none", color: viewMode === "tree" ? COLORS.accent : COLORS.textMuted, cursor: "pointer", fontWeight: viewMode === "tree" ? 600 : 400 }}>
              {viewMode === "tab" ? "⋮ tree" : "≡ tab"}
            </button>
          )}
          <button onClick={onDelete} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #E5A0A0", background: "none", color: "#C53030", cursor: "pointer", fontWeight: 600 }}>✕</button>
          <button onClick={onClose} style={{ fontSize: 16, background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: "0 4px" }}>←</button>
        </div>
      </div>

      {/* Screenshot */}
      {annotation.screenshot && (
        <div style={{ padding: "12px 20px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.accentLight }}>
          <img src={`data:image/png;base64,${annotation.screenshot}`} style={{ maxWidth: "100%", maxHeight: 100, borderRadius: 4 }} alt="" />
        </div>
      )}

      {isClaude ? (
        <>
          {/* Chat area */}
          <div ref={chatRef} style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
            {/* Tree mode: show all branches as an indented tree */}
            {viewMode === "tree" && annotation.msgRoot && (
              <div style={{ marginBottom: 8 }}>
                {annotation.msgRoot.children.map((child) => (
                  <TreeNode key={child.id} node={child} depth={0}
                    activePathIds={activePathIds} onSelectNode={selectTreeNode} />
                ))}
              </div>
            )}
            {/* Tab mode: linear view of active path */}
            {viewMode === "tab" && visibleNodes.map((node) => {
              // Branch tabs: shown beneath an assistant node when it has multiple children
              const branchCount = node.role === "assistant" ? node.children.length : 0;
              const activeBranchIdx = annotation.activeBranchAt?.[node.id] ?? 0;
              const isHovered = hoveredNodeId === node.id;

              return (
                <div key={node.id}>
                  {/* Message bubble */}
                  <div
                    style={{ marginBottom: branchCount > 1 ? 6 : 16 }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: node.role === "user" ? COLORS.accent : COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {node.role === "user" ? "You" : "Claude"}
                      </div>
                      {/* Action buttons — branch + star — visible on hover (star also visible when saved) */}
                      {node.role === "assistant" && !node.isError && (
                        <div style={{ display: "flex", gap: 4 }}>
                          {isHovered && (
                            <button
                              onClick={() => { setReplyToNodeId(node.id); inputRef.current?.focus(); }}
                              title="Start a new branch from this response"
                              style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: `1px solid ${COLORS.border}`, background: replyToNodeId === node.id ? COLORS.accentLight : "none", color: COLORS.textMuted, cursor: "pointer", flexShrink: 0 }}>
                              ↩ branch
                            </button>
                          )}
                          {(isHovered || loggedNodeIds?.has(node.id)) && (
                            <button
                              onClick={() => onToggleLog?.(node.id, typeof node.content === "string" ? node.content : "")}
                              title={loggedNodeIds?.has(node.id) ? "Remove from knowledge log" : "Save to knowledge log"}
                              style={{ fontSize: 12, padding: "1px 6px", borderRadius: 5, border: `1px solid ${loggedNodeIds?.has(node.id) ? "#D97706" : COLORS.border}`, background: loggedNodeIds?.has(node.id) ? "#FEF3C7" : "none", color: loggedNodeIds?.has(node.id) ? "#D97706" : COLORS.textMuted, cursor: "pointer", flexShrink: 0 }}>
                              {loggedNodeIds?.has(node.id) ? "★" : "☆"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {node.role === "assistant" && !node.isError
                      ? <div style={{ fontSize: 14, color: COLORS.text }}><Markdown text={node.content} /></div>
                      : <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: node.isError ? "#991B1B" : COLORS.text, background: node.isError ? "#FEE2E2" : "none", padding: node.isError ? "8px 10px" : 0, borderRadius: node.isError ? 6 : 0 }}>
                          {typeof node.content === "string" ? node.content : node.content?.find?.((b) => b.type === "text")?.text || ""}
                        </div>}
                  </div>

                  {/* Branch tabs — shown when this assistant node has more than one child */}
                  {branchCount > 1 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 12, paddingLeft: 2 }}>
                      <span style={{ fontSize: 10, color: COLORS.textMuted, marginRight: 2 }}>Branches:</span>
                      {Array.from({ length: branchCount }, (_, idx) => (
                        <button key={idx} onClick={() => onBranchSelect(node.id, idx)}
                          style={{ fontSize: 11, padding: "2px 9px", borderRadius: 10, border: `1px solid ${idx === activeBranchIdx ? COLORS.accent : COLORS.border}`, background: idx === activeBranchIdx ? COLORS.accentLight : "none", color: idx === activeBranchIdx ? COLORS.accent : COLORS.textMuted, cursor: "pointer", fontWeight: idx === activeBranchIdx ? 600 : 400, transition: "all 0.12s" }}>
                          {idx + 1}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* End of tab mode block */}
            {annotation.loading && (
              <div style={{ fontSize: 14, color: COLORS.textMuted }}><span className="loading-dots">Thinking</span></div>
            )}
          </div>

          {/* Input area */}
          <div style={{ padding: "12px 20px", borderTop: `1px solid ${COLORS.border}`, background: COLORS.sidebar }}>
            {/* Branch context indicator */}
            {replyToNode && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "5px 10px", borderRadius: 6, background: COLORS.accentLight, border: `1px solid ${COLORS.border}` }}>
                <span style={{ fontSize: 11, color: COLORS.accent }}>
                  ↩ Branching from: "{String(replyToNode.content || "").slice(0, 50)}{String(replyToNode.content || "").length > 50 ? "…" : ""}"
                </span>
                <button onClick={() => setReplyToNodeId(null)} style={{ fontSize: 12, background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: "0 2px" }}>×</button>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={replyToNode ? "Type a new branch…" : "Ask a follow-up… (Shift+Enter for new line)"}
                rows={1}
                style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 14, color: COLORS.text, outline: "none", resize: "none", overflow: "hidden", lineHeight: 1.5, fontFamily: "'DM Sans', sans-serif", minHeight: 42, maxHeight: 160 }} />
              <button onClick={send} disabled={!input.trim()}
                style={{ padding: "10px 16px", borderRadius: 8, background: input.trim() ? COLORS.accent : COLORS.border, color: "#fff", border: "none", cursor: input.trim() ? "pointer" : "default", fontWeight: 600 }}>↑</button>
            </div>
          </div>
        </>
      ) : isResearch ? (
        <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
          <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(155,89,182,0.08)", border: "1px solid rgba(155,89,182,0.2)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9B59B6", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Research Question</div>
            <div style={{ fontSize: 14, color: COLORS.text, lineHeight: 1.6 }}>{annotation.question}</div>
          </div>
          {annotation.rawText && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Passage</div>
              <div style={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.6, fontStyle: "italic", borderLeft: "3px solid rgba(155,89,182,0.4)", paddingLeft: 10 }}>{annotation.rawText}</div>
            </div>
          )}
          <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Notes</div>
          <textarea value={annotation.note || ""} onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Add notes, sources, follow-up thoughts…"
            style={{ width: "100%", minHeight: 120, padding: 14, borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 14, color: COLORS.text, outline: "none", resize: "vertical", lineHeight: 1.7, fontFamily: "'DM Sans', sans-serif" }} />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Note</div>
          <textarea value={annotation.note || ""} onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Add your notes here…"
            style={{ width: "100%", minHeight: 160, padding: 14, borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 14, color: COLORS.text, outline: "none", resize: "vertical", lineHeight: 1.7, fontFamily: "'DM Sans', sans-serif" }} />
        </div>
      )}
    </div>
  );
}

/* ── Sidebar ── */
function Sidebar({ annotations, activeId, onSelect, onDelete, knowledgeLog = [], onSelectLog, onRemoveLog,
  annotations2, activeId2, onSelect2, fileName2 }) {
  const hasPdf2 = Array.isArray(annotations2);
  const [tab, setTab] = useState("annotations"); // "annotations" | "pdf2" | "log" | "research"
  // Reset to annotations tab when split view is closed
  useEffect(() => { if (!hasPdf2 && tab === "pdf2") setTab("annotations"); }, [hasPdf2]);
  const highlights = annotations.filter((a) => a.type === "highlight");
  const activeClaudes = annotations.filter((a) => a.type === "claude" && a.status === "active");
  const resolvedClaudes = annotations.filter((a) => a.type === "claude" && a.status === "resolved");
  const researchAnns = annotations.filter((a) => a.type === "research");

  const Item = ({ ann }) => {
    const c = getHlColor(ann.color);
    const activePath = ann.msgRoot ? getActivePath(ann.msgRoot, ann.activeBranchAt) : [];
    const firstAssistant = activePath.find((n) => n.role === "assistant");
    const followUpCount = activePath.filter((n) => n.role === "user").length - 1;
    const previewContent = firstAssistant?.content;
    const preview = ann.type === "claude"
      ? (typeof previewContent === "string" ? previewContent : (ann.loading ? "Thinking…" : ""))
      : (ann.note || "No note");
    return (
      <div style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${COLORS.border}` }}>
        <button onClick={() => onSelect(ann.id)} style={{
          flex: 1, minWidth: 0, textAlign: "left", padding: "12px 16px",
          background: ann.id === activeId ? COLORS.accentLight : "transparent",
          border: "none", cursor: "pointer", borderLeft: `3px solid ${ann.id === activeId ? c.dot : "transparent"}`,
          fontFamily: "'DM Sans', sans-serif",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: COLORS.textMuted }}>
              Page {ann.pageNum} · {ann.type === "claude" ? (followUpCount > 0 ? `${followUpCount} follow-up${followUpCount > 1 ? "s" : ""}` : "Quick answer") : "Highlight"}
            </span>
          </div>
          <div style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</div>
        </button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(ann.id); }}
          style={{ padding: "0 10px", background: "none", border: "none", cursor: "pointer", color: COLORS.border, fontSize: 14 }}
          onMouseEnter={(e) => e.currentTarget.style.color = "#C53030"}
          onMouseLeave={(e) => e.currentTarget.style.color = COLORS.border}>✕</button>
      </div>
    );
  };

  const Section = ({ title, items }) => items.length ? (
    <>
      <div style={{ padding: "8px 16px", fontSize: 11, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, background: COLORS.sidebar }}>{title}</div>
      {items.map((a) => <Item key={a.id} ann={a} />)}
    </>
  ) : null;

  const sortedLog = [...knowledgeLog].sort((a, b) => b.ts - a.ts);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.sidebar }}>
        {[
          { id: "annotations", label: hasPdf2 ? `PDF 1 (${annotations.length})` : `Annotations (${annotations.length})`, color: COLORS.accent },
          ...(hasPdf2 ? [{ id: "pdf2", label: `PDF 2 (${annotations2.length})`, color: COLORS.accent }] : []),
          { id: "research", label: `Research${researchAnns.length > 0 ? ` (${researchAnns.length})` : ""}`, color: "#9B59B6" },
          { id: "log", label: `Log${knowledgeLog.length > 0 ? ` (${knowledgeLog.length})` : ""}`, color: COLORS.accent },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex: 1, padding: "11px 4px", fontSize: 11, fontWeight: 600, border: "none", background: "none", cursor: "pointer", color: tab === t.id ? t.color : COLORS.textMuted, borderBottom: tab === t.id ? `2px solid ${t.color}` : "2px solid transparent", transition: "color 0.12s", letterSpacing: "0.03em", textTransform: "uppercase" }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "pdf2" && hasPdf2 ? (
          <>
            {annotations2.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: COLORS.textMuted, fontSize: 14, lineHeight: 1.6 }}>No annotations in this PDF yet</div>
            ) : annotations2.map((ann) => {
              const c = getHlColor(ann.color);
              const activePath = ann.msgRoot ? getActivePath(ann.msgRoot, ann.activeBranchAt) : [];
              const firstAsst = activePath.find((n) => n.role === "assistant");
              const preview = ann.type === "claude"
                ? (typeof firstAsst?.content === "string" ? firstAsst.content : (ann.loading ? "Thinking…" : ""))
                : (ann.note || "No note");
              return (
                <div key={ann.id} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                  <button onClick={() => onSelect2?.(ann.id)}
                    style={{ width: "100%", textAlign: "left", padding: "12px 16px", background: ann.id === activeId2 ? COLORS.accentLight : "transparent", border: "none", cursor: "pointer", borderLeft: `3px solid ${ann.id === activeId2 ? c.dot : "transparent"}`, fontFamily: "'DM Sans', sans-serif" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: COLORS.textMuted }}>Page {ann.pageNum} · {ann.type === "claude" ? "Question" : "Highlight"}</span>
                    </div>
                    <div style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</div>
                  </button>
                </div>
              );
            })}
          </>
        ) : tab === "annotations" ? (
          <>
            {annotations.filter((a) => a.type !== "research").length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: COLORS.textMuted, fontSize: 14, lineHeight: 1.6 }}>
                Select text, then press <b>H</b> to highlight or <b>C</b> to ask Claude
              </div>
            )}
            <Section title="Highlights" items={highlights} />
            <Section title="Questions" items={activeClaudes} />
            <Section title="Resolved" items={resolvedClaudes} />
          </>
        ) : tab === "research" ? (
          <>
            {researchAnns.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: COLORS.textMuted, fontSize: 14, lineHeight: 1.6 }}>
                Select text, then press <b>R</b> to capture a research question
              </div>
            ) : researchAnns.map((ann) => (
              <div key={ann.id} style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${COLORS.border}` }}>
                <button onClick={() => onSelect(ann.id)}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", padding: "12px 16px", background: ann.id === activeId ? "rgba(155,89,182,0.08)" : "transparent", border: "none", cursor: "pointer", borderLeft: `3px solid ${ann.id === activeId ? "#9B59B6" : "transparent"}`, fontFamily: "'DM Sans', sans-serif" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#9B59B6", flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: COLORS.textMuted }}>Page {ann.pageNum}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#9B59B6", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{ann.question}</div>
                  {ann.rawText && <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: "italic" }}>{ann.rawText}</div>}
                </button>
                <button onClick={(e) => { e.stopPropagation(); onDelete(ann.id); }}
                  style={{ padding: "0 10px", background: "none", border: "none", cursor: "pointer", color: COLORS.border, fontSize: 14 }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#C53030"}
                  onMouseLeave={(e) => e.currentTarget.style.color = COLORS.border}>✕</button>
              </div>
            ))}
          </>
        ) : (
          <>
            {sortedLog.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: COLORS.textMuted, fontSize: 14, lineHeight: 1.6 }}>
                Hover over a Claude response and press <b>☆</b> to save it here
              </div>
            ) : sortedLog.map((entry) => (
              <div key={entry.id} style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${COLORS.border}` }}>
                <button onClick={() => onSelectLog?.(entry.annId)}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                  onMouseLeave={(e) => e.currentTarget.style.background = "none"}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: "#D97706" }}>★</span>
                    <span style={{ fontSize: 11, color: COLORS.textMuted }}>Page {entry.pageNum}</span>
                  </div>
                  <div style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                    {entry.text}
                  </div>
                </button>
                <button onClick={() => onRemoveLog?.(entry.id)}
                  style={{ padding: "0 10px", background: "none", border: "none", cursor: "pointer", color: COLORS.border, fontSize: 14 }}
                  onMouseEnter={(e) => e.currentTarget.style.color = "#C53030"}
                  onMouseLeave={(e) => e.currentTarget.style.color = COLORS.border}>✕</button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Knowledge Graph ── */
function KnowledgeGraph({ onClose }) {
  const W = 760, H = 500;
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error | empty
  const [errMsg, setErrMsg] = useState("");
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [hovered, setHovered] = useState(null);
  const posRef = useRef({});
  const dragRef = useRef(null);
  const animRef = useRef(null);
  const tickRef = useRef(0);
  const svgRef = useRef(null);
  const cx = W / 2, cy = H / 2;

  const K_REPEL = 3000, K_SPRING = 0.035, K_DAMP = 0.80, K_CENTER = 0.012;

  const stopSim = () => { if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; } };

  const runSim = (nodesArr, edgesArr) => {
    stopSim();
    const tick = () => {
      const pos = posRef.current;
      const ids = nodesArr.map((n) => n.id);
      const forces = {};
      ids.forEach((id) => { forces[id] = { fx: 0, fy: 0 }; });
      // Repulsion
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j];
          const dx = (pos[b]?.x ?? cx) - (pos[a]?.x ?? cx);
          const dy = (pos[b]?.y ?? cy) - (pos[a]?.y ?? cy);
          const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const f = K_REPEL / (d * d);
          forces[a].fx -= (dx / d) * f; forces[a].fy -= (dy / d) * f;
          forces[b].fx += (dx / d) * f; forces[b].fy += (dy / d) * f;
        }
      }
      // Spring attraction along edges
      edgesArr.forEach(({ source, target }) => {
        const pa = pos[source], pb = pos[target];
        if (!pa || !pb) return;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = K_SPRING * (d - 90);
        forces[source].fx += (dx / d) * f; forces[source].fy += (dy / d) * f;
        forces[target].fx -= (dx / d) * f; forces[target].fy -= (dy / d) * f;
      });
      // Center gravity
      ids.forEach((id) => { forces[id].fx += (cx - pos[id].x) * K_CENTER; forces[id].fy += (cy - pos[id].y) * K_CENTER; });
      // Integrate
      let maxV = 0;
      ids.forEach((id) => {
        if (dragRef.current?.id === id) return;
        const p = pos[id];
        p.vx = (p.vx + forces[id].fx) * K_DAMP;
        p.vy = (p.vy + forces[id].fy) * K_DAMP;
        p.x = Math.max(50, Math.min(W - 50, p.x + p.vx));
        p.y = Math.max(35, Math.min(H - 35, p.y + p.vy));
        maxV = Math.max(maxV, Math.abs(p.vx) + Math.abs(p.vy));
      });
      tickRef.current++;
      if (tickRef.current % 3 === 0) {
        setNodes((prev) => prev.map((n) => ({ ...n, x: pos[n.id]?.x ?? n.x, y: pos[n.id]?.y ?? n.y })));
      }
      if (tickRef.current < 400 && maxV > 0.08) { animRef.current = requestAnimationFrame(tick); }
      else { setNodes((prev) => prev.map((n) => ({ ...n, x: pos[n.id]?.x ?? n.x, y: pos[n.id]?.y ?? n.y }))); }
    };
    tickRef.current = 0;
    animRef.current = requestAnimationFrame(tick);
  };

  const generateGraph = async () => {
    setStatus("loading"); setErrMsg("");
    try {
      const klogRes = await fetch("/api/all-klogs").then((r) => r.ok ? r.json() : null).catch(() => null);
      const entries = klogRes?.entries || [];
      if (entries.length === 0) { setStatus("empty"); return; }
      const entrySummaries = entries.slice(0, 60)
        .map((e) => `[${e.pdfName}, p.${e.pageNum}] ${(e.text || "").slice(0, 200)}`).join("\n");
      const prompt = `Analyze these knowledge log entries from the user's academic reading sessions and identify key concepts and relationships between them.
Return ONLY valid JSON — no markdown, no extra text:
{"nodes":[{"id":"n1","label":"Short Label","papers":["paper.pdf"],"type":"concept"}],"edges":[{"source":"n1","target":"n2","label":"relates to"}]}
Rules:
- 8-16 concept nodes total
- Node type one of: "concept", "theme", "method", "question"
- Edges represent meaningful cross-concept relationships (not just co-occurrence)
- Labels: 1-4 words max
- Each node's "papers" array lists which PDF filenames it appears in

Knowledge log entries:
${entrySummaries}`;
      const res = await fetch("/api/claude", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "API error");
      const raw = data.content?.[0]?.text || "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No valid JSON in response");
      const graph = JSON.parse(jsonMatch[0]);
      const nodeList = (graph.nodes || []).map((n, i, arr) => {
        const angle = (i / arr.length) * 2 * Math.PI;
        const r = Math.min(W, H) * 0.28;
        return { ...n, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
      });
      const pos = {};
      nodeList.forEach((n) => { pos[n.id] = { x: n.x, y: n.y, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 4 }; });
      posRef.current = pos;
      setNodes(nodeList);
      setEdges(graph.edges || []);
      setStatus("ready");
      runSim(nodeList, graph.edges || []);
    } catch (e) { setErrMsg(e.message); setStatus("error"); }
  };

  useEffect(() => { return stopSim; }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragRef.current) return;
      const { id, startX, startY, origX, origY } = dragRef.current;
      const svgRect = svgRef.current?.getBoundingClientRect();
      if (!svgRect) return;
      const scaleX = W / svgRect.width, scaleY = H / svgRect.height;
      const newX = Math.max(50, Math.min(W - 50, origX + (e.clientX - startX) * scaleX));
      const newY = Math.max(35, Math.min(H - 35, origY + (e.clientY - startY) * scaleY));
      posRef.current[id].x = newX; posRef.current[id].y = newY;
      posRef.current[id].vx = 0; posRef.current[id].vy = 0;
      setNodes((prev) => prev.map((n) => n.id === id ? { ...n, x: newX, y: newY } : n));
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const NODE_COLORS = { concept: "#4A90D9", theme: "#6B9E78", method: "#D97706", question: "#9B59B6" };
  const nodeColor = (type) => NODE_COLORS[type] || "#888";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: COLORS.paper, borderRadius: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.25)", padding: "24px 28px", width: W + 56, maxWidth: "96vw" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>Knowledge Graph</div>
            <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>Concepts extracted from your starred reading notes</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {status !== "loading" && (
              <button onClick={generateGraph}
                style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: COLORS.accent, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                {status === "ready" ? "Regenerate" : "Generate"}
              </button>
            )}
            <button onClick={onClose}
              style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, fontSize: 12, cursor: "pointer" }}>
              Close
            </button>
          </div>
        </div>

        <div style={{ height: H, position: "relative", background: COLORS.bg, borderRadius: 10, overflow: "hidden" }}>
          {status === "idle" && (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: COLORS.textMuted }}>
              <div style={{ fontSize: 40 }}>🕸</div>
              <div style={{ fontSize: 13, textAlign: "center", maxWidth: 320 }}>Click Generate to extract a concept map from your starred reading notes</div>
            </div>
          )}
          {status === "loading" && (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.textMuted, fontSize: 13 }}>
              <span className="loading-dots">Analyzing your reading</span>
            </div>
          )}
          {status === "empty" && (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: COLORS.textMuted, padding: "0 40px", textAlign: "center" }}>
              <div style={{ fontSize: 32 }}>☆</div>
              <div style={{ fontSize: 13 }}>No starred notes found. While reading, click ☆ on Claude responses to save insights. They'll appear here as connected concepts.</div>
            </div>
          )}
          {status === "error" && (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#C53030", fontSize: 13, padding: "0 32px", textAlign: "center" }}>Error: {errMsg}</div>
          )}
          {status === "ready" && (
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"
              style={{ display: "block", cursor: dragRef.current ? "grabbing" : "grab", userSelect: "none" }}>
              <defs>
                <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L6,3 z" fill={COLORS.border} />
                </marker>
              </defs>
              {edges.map((e, i) => {
                const a = nodes.find((n) => n.id === e.source);
                const b = nodes.find((n) => n.id === e.target);
                if (!a || !b) return null;
                return (
                  <g key={i}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={COLORS.border} strokeWidth={1.5} opacity={0.7} />
                    {e.label && (
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} textAnchor="middle" fontSize={9}
                        fill={COLORS.textMuted} dy={-4} style={{ pointerEvents: "none" }}>{e.label}</text>
                    )}
                  </g>
                );
              })}
              {nodes.map((n) => {
                const r = 24;
                const isHov = hovered === n.id;
                return (
                  <g key={n.id} transform={`translate(${n.x},${n.y})`}
                    onMouseDown={(e) => { e.preventDefault(); dragRef.current = { id: n.id, startX: e.clientX, startY: e.clientY, origX: n.x, origY: n.y }; }}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    style={{ cursor: "pointer" }}>
                    <circle r={r} fill={nodeColor(n.type)} opacity={isHov ? 1 : 0.8} stroke="#fff" strokeWidth={2.5} />
                    <text textAnchor="middle" dy="0.35em" fontSize={9} fontWeight={600} fill="#fff"
                      style={{ pointerEvents: "none" }}>
                      {n.label.length > 14 ? n.label.slice(0, 12) + "…" : n.label}
                    </text>
                    <text textAnchor="middle" dy={r + 13} fontSize={10} fill={COLORS.text} fontWeight={600}
                      style={{ pointerEvents: "none" }}>
                      {n.label.length > 18 ? n.label.slice(0, 16) + "…" : n.label}
                    </text>
                    {isHov && n.papers?.length > 0 && (
                      <text textAnchor="middle" dy={r + 25} fontSize={9} fill={COLORS.textMuted}
                        style={{ pointerEvents: "none" }}>
                        {n.papers.slice(0, 2).map((p) => p.replace(/\.pdf$/i, "").slice(0, 18)).join(", ")}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {status === "ready" && (
          <div style={{ display: "flex", gap: 14, marginTop: 12, justifyContent: "center" }}>
            {Object.entries(NODE_COLORS).map(([label, color]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: COLORS.textMuted }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: color }} />
                {label}
              </div>
            ))}
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 8 }}>· drag nodes to rearrange</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Upload ── */
function UploadScreen({ onUpload, loading, error, history, onRemoveHistory, projects = [], onProjectsChange }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [hintName, setHintName] = useState(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef(null);
  // Project state
  const [expandedProjId, setExpandedProjId] = useState(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [addToProjId, setAddToProjId] = useState(null);
  const [projKlogs, setProjKlogs] = useState({});
  const [projChatOpen, setProjChatOpen] = useState(false);
  const [kgOpen, setKgOpen] = useState(false);
  const [projChatMsgs, setProjChatMsgs] = useState([]);
  const [projChatInput, setProjChatInput] = useState("");
  const [projChatLoading, setProjChatLoading] = useState(false);
  const [researchQueue, setResearchQueue] = useState([]);
  const [synthResult, setSynthResult] = useState(null);
  const [synthLoading, setSynthLoading] = useState(false);

  const readFile = (file) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) { alert("Please upload a PDF."); return; }
    setHintName(null);
    const reader = new FileReader();
    reader.onload = (e) => onUpload(e.target.result, file.name);
    reader.readAsArrayBuffer(file);
  };

  const openHistory = async (name) => {
    const buffer = await loadPdfIDB(name);
    if (buffer) { onUpload(buffer, name); return; }
    setHintName(name);
    inputRef.current?.click();
  };

  const runSearch = async (q) => {
    if (!q.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch { setSearchResults([]); }
    finally { setSearching(false); }
  };

  const handleSearchChange = (q) => {
    setSearchQ(q);
    clearTimeout(searchTimerRef.current);
    if (!q.trim()) { setSearchResults(null); return; }
    searchTimerRef.current = setTimeout(() => runSearch(q), 380);
  };

  // Fetch research queue on mount
  useEffect(() => {
    fetch("/api/all-research")
      .then((r) => r.ok ? r.json() : { entries: [] })
      .then((d) => setResearchQueue(d.entries || []))
      .catch(() => {});
  }, []);

  const synthesizeResearch = async () => {
    if (!researchQueue.length || synthLoading) return;
    setSynthLoading(true); setSynthResult(null);
    const lines = researchQueue.map((e) => `- [${e.pdfName}, p.${e.pageNum}] "${e.question}" (passage: "${(e.rawText || "").slice(0, 80)}")`).join("\n");
    try {
      const resp = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 1024,
          system: "You are a research synthesis assistant. Given a list of research questions captured while reading, group them into thematic clusters. For each cluster, provide a short theme name and list the relevant questions. Be concise.",
          messages: [{ role: "user", content: `Here are my research questions from various readings:\n\n${lines}\n\nGroup these into themes. Use markdown with bold theme headers.` }],
        }),
      });
      const data = await resp.json();
      const text = Array.isArray(data.content) ? data.content.find((b) => b.type === "text")?.text : data.content;
      setSynthResult(text || "No response.");
    } catch (e) { setSynthResult(`Error: ${e.message}`); }
    finally { setSynthLoading(false); }
  };

  // Fetch and aggregate knowledge-log entries for all PDFs in the expanded project
  useEffect(() => {
    setProjChatOpen(false);
    setProjChatMsgs([]);
    setProjChatInput("");
    if (!expandedProjId) return;
    const proj = projects.find((p) => p.id === expandedProjId);
    if (!proj || !proj.pdfNames.length) return;
    Promise.all(proj.pdfNames.map(async (name) => {
      try {
        const r = await fetch(`/api/klog/${sanitizeForUrl(name)}`);
        const d = r.ok ? await r.json() : null;
        return (d?.data || []).map((e) => ({ ...e, pdfName: name }));
      } catch { return []; }
    })).then((arrs) => {
      const merged = arrs.flat().sort((a, b) => b.ts - a.ts);
      setProjKlogs((prev) => ({ ...prev, [expandedProjId]: merged }));
    });
  }, [expandedProjId]);

  const askProjectClaude = async (question) => {
    if (!question.trim() || projChatLoading || !expandedProjId) return;
    const proj = projects.find((p) => p.id === expandedProjId);
    if (!proj) return;
    const userMsg = { role: "user", content: question };
    const currentMsgs = [...projChatMsgs, userMsg];
    setProjChatMsgs(currentMsgs);
    setProjChatInput("");
    setProjChatLoading(true);
    try {
      // Gather annotation Q&A context from all project PDFs
      const allAnns = await Promise.all(proj.pdfNames.map(async (name) => {
        try {
          const r = await fetch(`/api/annotations/${sanitizeForUrl(name)}`);
          const d = r.ok ? await r.json() : null;
          return { name, anns: d?.data || [] };
        } catch { return { name, anns: [] }; }
      }));
      const starred = projKlogs[expandedProjId] || [];
      const ctxLines = [`You are an academic reading assistant. The user is working on a reading project called "${proj.name}" with these papers:\n`];
      for (const { name, anns } of allAnns) {
        ctxLines.push(`\n### ${name}`);
        const pdfStarred = starred.filter((e) => e.pdfName === name);
        if (pdfStarred.length) {
          ctxLines.push("Starred insights:");
          pdfStarred.slice(0, 6).forEach((e) => ctxLines.push(`- (p.${e.pageNum}) ${e.text.slice(0, 300)}`));
        }
        const claudeAnns = anns.filter((a) => a.type === "claude" && a.msgRoot?.children?.length > 0).slice(0, 6);
        if (claudeAnns.length) {
          ctxLines.push("Q&A highlights:");
          claudeAnns.forEach((a) => {
            const q = (a.rawText || "").slice(0, 120);
            const firstAsst = a.msgRoot?.children?.[0];
            const ans = (typeof firstAsst?.content === "string" ? firstAsst.content : "").slice(0, 280);
            ctxLines.push(`- Q (p.${a.pageNum}): "${q}" → ${ans}`);
          });
        }
      }
      ctxLines.push("\nDraw on the above context to answer the user's question about their reading. Be concise and insightful. Where relevant, mention which paper(s) are involved.");
      const systemPrompt = ctxLines.join("\n").slice(0, 60000);
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          messages: currentMsgs.slice(-10),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "API error");
      const answer = data.content?.[0]?.text || "";
      setProjChatMsgs((prev) => [...prev, { role: "assistant", content: answer }]);
    } catch (e) {
      setProjChatMsgs((prev) => [...prev, { role: "assistant", content: `Error: ${e.message}`, isError: true }]);
    } finally {
      setProjChatLoading(false);
    }
  };

  // Map a sanitized pdfName back to the original filename via history
  const resolveHistName = (pdfName) => history.find((h) => sanitizeForUrl(h.name) === pdfName)?.name;

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: COLORS.bg, fontFamily: "'Source Serif 4', Georgia, serif" }}>
      <div style={{ width: "100%", maxWidth: 520, padding: "0 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>📖</div>
          <h1 style={{ fontSize: 32, fontWeight: 700, color: COLORS.text, marginBottom: 8, letterSpacing: "-0.02em" }}>Reading Companion</h1>
          <p style={{ fontSize: 16, color: COLORS.textMuted, lineHeight: 1.6 }}>Upload a paper or textbook chapter. Highlight or ask Claude about anything confusing.</p>
        </div>

        {error && <div style={{ marginBottom: 16, padding: "12px 16px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 14 }}>{error}</div>}
        {hintName && <div style={{ marginBottom: 12, padding: "10px 14px", background: COLORS.accentLight, borderRadius: 8, fontSize: 13, color: COLORS.text }}>Please select <strong>{hintName}</strong> from your files.</div>}

        {loading
          ? <div style={{ padding: 32, textAlign: "center", color: COLORS.textMuted }}><span className="loading-dots">Loading PDF</span></div>
          : (
            <div onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files[0]); }}
              style={{ padding: "40px 32px", borderRadius: 16, border: `2px dashed ${dragOver ? COLORS.accent : COLORS.border}`, background: dragOver ? COLORS.accentLight : COLORS.paper, cursor: "pointer", textAlign: "center" }}>
              <div style={{ fontSize: 18, color: COLORS.text, fontWeight: 600, marginBottom: 6 }}>Drop a PDF here</div>
              <div style={{ fontSize: 14, color: COLORS.textMuted }}>or click to browse</div>
              <input ref={inputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={(e) => readFile(e.target.files?.[0])} />
            </div>
          )
        }

        {/* Cross-document search + Knowledge Graph button */}
        <div style={{ marginTop: 24, display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input
              value={searchQ}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search notes across all PDFs…"
              style={{ width: "100%", padding: "10px 14px", paddingRight: searchQ ? 32 : 14, borderRadius: 10, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 14, color: COLORS.text, outline: "none", boxSizing: "border-box", fontFamily: "'DM Sans', sans-serif" }}
              onFocus={(e) => e.currentTarget.style.borderColor = COLORS.accent}
              onBlur={(e) => e.currentTarget.style.borderColor = COLORS.border}
            />
            {searchQ && (
              <button onClick={() => handleSearchChange("")}
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, fontSize: 14, padding: "0 2px" }}>×</button>
            )}
          </div>
          <button onClick={() => setKgOpen(true)} title="Knowledge Graph"
            style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${COLORS.border}`, background: COLORS.paper, color: COLORS.textMuted, fontSize: 16, cursor: "pointer", flexShrink: 0, lineHeight: 1 }}>🕸</button>
        </div>

        {kgOpen && <KnowledgeGraph onClose={() => setKgOpen(false)} />}

        {/* Search results */}
        {searching && <div style={{ marginTop: 12, textAlign: "center", color: COLORS.textMuted, fontSize: 13 }}><span className="loading-dots">Searching</span></div>}
        {searchResults !== null && !searching && (
          <div style={{ marginTop: 12 }}>
            {searchResults.length === 0 ? (
              <div style={{ padding: "16px", textAlign: "center", color: COLORS.textMuted, fontSize: 13 }}>No results for "{searchQ}"</div>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                  {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
                </div>
                <div style={{ borderRadius: 12, border: `1px solid ${COLORS.border}`, overflow: "hidden", background: COLORS.paper }}>
                  {searchResults.map((r, idx) => {
                    const origName = resolveHistName(r.pdfName);
                    return (
                      <div key={idx} style={{ borderTop: idx > 0 ? `1px solid ${COLORS.border}` : "none", display: "flex", alignItems: "stretch" }}>
                        <div style={{ flex: 1, padding: "12px 16px", minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>
                            <span style={{ fontWeight: 600, color: COLORS.accent }}>{origName || r.pdfName}</span>
                            <span> · Page {r.pageNum}</span>
                          </div>
                          <div style={{ fontSize: 12, color: COLORS.text, fontStyle: "italic", lineHeight: 1.4, marginBottom: r.answer ? 4 : 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            "{r.rawText.slice(0, 120)}{r.rawText.length > 120 ? "…" : ""}"
                          </div>
                          {r.answer && (
                            <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                              {r.answer}
                            </div>
                          )}
                        </div>
                        {origName && (
                          <button onClick={() => openHistory(origName)}
                            style={{ padding: "0 14px", background: "none", border: "none", borderLeft: `1px solid ${COLORS.border}`, cursor: "pointer", color: COLORS.accent, fontSize: 12, fontWeight: 600, flexShrink: 0 }}
                            onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                            onMouseLeave={(e) => e.currentTarget.style.background = "none"}>
                            Open →
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Projects section — hidden when searching */}
        {searchResults === null && (
          <div style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Projects</div>
              {!creatingProject && (
                <button onClick={() => { setCreatingProject(true); setNewProjectName(""); }}
                  style={{ fontSize: 11, color: COLORS.accent, background: "none", border: "none", cursor: "pointer", padding: "2px 6px", fontWeight: 600 }}>+ New</button>
              )}
            </div>

            {creatingProject && (
              <div style={{ marginBottom: 8, display: "flex", gap: 8 }}>
                <input autoFocus value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Project name…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newProjectName.trim()) {
                      onProjectsChange([...projects, { id: `proj-${Date.now()}`, name: newProjectName.trim(), pdfNames: [], createdAt: Date.now() }]);
                      setCreatingProject(false); setNewProjectName("");
                    }
                    if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); }
                  }}
                  onBlur={() => {
                    if (newProjectName.trim()) onProjectsChange([...projects, { id: `proj-${Date.now()}`, name: newProjectName.trim(), pdfNames: [], createdAt: Date.now() }]);
                    setCreatingProject(false); setNewProjectName("");
                  }}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: `1px solid ${COLORS.accent}`, background: COLORS.paper, fontSize: 13, color: COLORS.text, outline: "none", fontFamily: "'DM Sans', sans-serif" }} />
              </div>
            )}

            {projects.length === 0 && !creatingProject ? (
              <div style={{ padding: "12px 16px", fontSize: 13, color: COLORS.textMuted, background: COLORS.paper, borderRadius: 10, border: `1px solid ${COLORS.border}`, textAlign: "center" }}>
                Group related PDFs into projects
              </div>
            ) : projects.length > 0 && (
              <div style={{ borderRadius: 12, border: `1px solid ${COLORS.border}`, overflow: "hidden", background: COLORS.paper }}>
                {projects.map((proj, idx) => {
                  const isExpanded = expandedProjId === proj.id;
                  const availableToAdd = history.filter((h) => !proj.pdfNames.includes(h.name));
                  return (
                    <div key={proj.id} style={{ borderTop: idx > 0 ? `1px solid ${COLORS.border}` : "none" }}>
                      {/* Project header */}
                      <div style={{ display: "flex", alignItems: "center", padding: "11px 14px" }}>
                        <button onClick={() => setExpandedProjId(isExpanded ? null : proj.id)}
                          style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: "'DM Sans', sans-serif" }}>
                          <span style={{ fontSize: 10, color: COLORS.textMuted, display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{proj.name}</span>
                          <span style={{ fontSize: 11, color: COLORS.textMuted }}>· {proj.pdfNames.length} PDF{proj.pdfNames.length !== 1 ? "s" : ""}</span>
                        </button>
                        <button onClick={() => { onProjectsChange(projects.filter((p) => p.id !== proj.id)); if (expandedProjId === proj.id) setExpandedProjId(null); }}
                          title="Delete project"
                          style={{ padding: "2px 6px", background: "none", border: "none", cursor: "pointer", color: COLORS.border, fontSize: 14 }}
                          onMouseEnter={(e) => e.currentTarget.style.color = "#C53030"}
                          onMouseLeave={(e) => e.currentTarget.style.color = COLORS.border}>✕</button>
                      </div>

                      {/* Expanded: PDF list + Add PDF */}
                      {isExpanded && (
                        <div style={{ borderTop: `1px solid ${COLORS.border}`, background: COLORS.bg, paddingBottom: 8 }}>
                          {proj.pdfNames.length === 0 && (
                            <div style={{ padding: "10px 16px 4px 32px", fontSize: 12, color: COLORS.textMuted }}>No PDFs yet — add one below</div>
                          )}
                          {proj.pdfNames.map((name) => (
                            <div key={name} style={{ display: "flex", alignItems: "center", padding: "6px 10px 6px 32px" }}>
                              <span style={{ flex: 1, fontSize: 12, color: COLORS.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                              <button onClick={() => openHistory(name)}
                                style={{ fontSize: 11, color: COLORS.accent, background: "none", border: "none", cursor: "pointer", padding: "3px 8px", fontWeight: 600 }}>Open</button>
                              <button onClick={() => onProjectsChange(projects.map((p) => p.id === proj.id ? { ...p, pdfNames: p.pdfNames.filter((n) => n !== name) } : p))}
                                style={{ padding: "2px 6px", background: "none", border: "none", cursor: "pointer", color: COLORS.border, fontSize: 13 }}
                                onMouseEnter={(e) => e.currentTarget.style.color = "#C53030"}
                                onMouseLeave={(e) => e.currentTarget.style.color = COLORS.border}>✕</button>
                            </div>
                          ))}

                          {addToProjId === proj.id ? (
                            <div style={{ margin: "6px 14px 4px 32px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, overflow: "hidden", maxHeight: 150, overflowY: "auto" }}>
                              {availableToAdd.length === 0 ? (
                                <div style={{ padding: "8px 12px", fontSize: 12, color: COLORS.textMuted }}>All recent files are already in this project.</div>
                              ) : availableToAdd.map((h, hi) => (
                                <button key={h.name} onClick={() => { onProjectsChange(projects.map((p) => p.id === proj.id ? { ...p, pdfNames: [...p.pdfNames, h.name] } : p)); setAddToProjId(null); }}
                                  style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none", border: "none", borderTop: hi > 0 ? `1px solid ${COLORS.border}` : "none", cursor: "pointer", fontSize: 12, color: COLORS.text, fontFamily: "'DM Sans', sans-serif" }}
                                  onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                                  onMouseLeave={(e) => e.currentTarget.style.background = "none"}>{h.name}</button>
                              ))}
                            </div>
                          ) : (
                            <button onClick={() => setAddToProjId(proj.id)}
                              style={{ display: "block", margin: "4px 14px 0 32px", fontSize: 11, color: COLORS.accent, background: "none", border: "none", cursor: "pointer", padding: "4px 0", fontWeight: 600 }}>
                              + Add PDF
                            </button>
                          )}

                          {/* Confusion tracker — starred insights aggregated from all project PDFs */}
                          {(() => {
                            const entries = projKlogs[proj.id] || [];
                            if (!entries.length) return null;
                            return (
                              <div style={{ margin: "10px 14px 4px 14px", borderTop: `1px solid ${COLORS.border}`, paddingTop: 8 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                                  ★ Starred Insights ({entries.length})
                                </div>
                                {entries.map((e, ei) => (
                                  <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderTop: ei > 0 ? `1px solid ${COLORS.border}` : "none" }}>
                                    <span style={{ color: "#D97706", fontSize: 11, flexShrink: 0, marginTop: 1 }}>★</span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 2 }}>
                                        p.{e.pageNum} · <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block", verticalAlign: "bottom", whiteSpace: "nowrap" }}>{e.pdfName}</span>
                                      </div>
                                      <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{e.text}</div>
                                    </div>
                                    <button onClick={() => openHistory(e.pdfName)}
                                      style={{ fontSize: 11, color: COLORS.accent, background: "none", border: "none", cursor: "pointer", padding: "3px 6px", fontWeight: 600, flexShrink: 0 }}>Open</button>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}

                          {/* Project-level Claude — ask across all papers */}
                          {proj.pdfNames.length > 0 && (
                            <div style={{ margin: "10px 14px 8px 14px", borderTop: `1px solid ${COLORS.border}`, paddingTop: 8 }}>
                              <button onClick={() => setProjChatOpen((v) => !v)}
                                style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: "2px 0", fontFamily: "'DM Sans', sans-serif" }}>
                                <span style={{ fontSize: 10, color: COLORS.textMuted, display: "inline-block", transform: projChatOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.accent }}>Ask across all papers</span>
                              </button>
                              {projChatOpen && (
                                <div style={{ marginTop: 8 }}>
                                  {projChatMsgs.map((m, mi) => (
                                    <div key={mi} style={{ marginBottom: 6, padding: "8px 10px", borderRadius: 8,
                                      background: m.role === "user" ? COLORS.accentLight : COLORS.paper,
                                      border: `1px solid ${m.role === "user" ? COLORS.accent + "40" : COLORS.border}`,
                                      fontSize: 12, color: m.isError ? "#C53030" : COLORS.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                                      {m.content}
                                    </div>
                                  ))}
                                  {projChatLoading && (
                                    <div style={{ padding: "8px 10px", fontSize: 12, color: COLORS.textMuted, fontStyle: "italic" }}>Thinking…</div>
                                  )}
                                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                                    <input value={projChatInput}
                                      onChange={(e) => setProjChatInput(e.target.value)}
                                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askProjectClaude(projChatInput); } }}
                                      placeholder="Ask about all papers in this project…"
                                      disabled={projChatLoading}
                                      style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 12, color: COLORS.text, outline: "none", fontFamily: "'DM Sans', sans-serif" }} />
                                    <button onClick={() => askProjectClaude(projChatInput)}
                                      disabled={projChatLoading || !projChatInput.trim()}
                                      style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: COLORS.accent, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: projChatLoading || !projChatInput.trim() ? 0.5 : 1 }}>Ask</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Recent files — hidden when search results are showing */}
        {searchResults === null && history.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Recent files</div>
            <div style={{ borderRadius: 12, border: `1px solid ${COLORS.border}`, overflow: "hidden", background: COLORS.paper }}>
              {history.map((h, idx) => (
                <div key={h.name} style={{ display: "flex", alignItems: "center", borderTop: idx > 0 ? `1px solid ${COLORS.border}` : "none" }}>
                  <button onClick={() => openHistory(h.name)} style={{ flex: 1, textAlign: "left", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                    onMouseLeave={(e) => e.currentTarget.style.background = "none"}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 }}>{h.name}</div>
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                      {h.annotationCount > 0 ? `${h.annotationCount} annotation${h.annotationCount !== 1 ? "s" : ""} · ` : ""}{formatAge(h.lastOpened)}
                    </div>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onRemoveHistory(h.name); }}
                    style={{ padding: "0 14px", alignSelf: "stretch", background: "none", border: "none", cursor: "pointer", color: COLORS.border, fontSize: 14 }}
                    title="Remove from history"
                    onMouseEnter={(e) => e.currentTarget.style.color = "#C53030"}
                    onMouseLeave={(e) => e.currentTarget.style.color = COLORS.border}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Research Queue — cross-document open questions */}
        {researchQueue.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#9B59B6" }} />
                <div style={{ fontSize: 11, fontWeight: 600, color: "#9B59B6", textTransform: "uppercase", letterSpacing: "0.06em" }}>Research Queue ({researchQueue.length})</div>
              </div>
              <button onClick={synthesizeResearch} disabled={synthLoading}
                style={{ fontSize: 11, padding: "5px 12px", borderRadius: 8, border: "none", background: synthLoading ? COLORS.border : "#9B59B6", color: "#fff", cursor: synthLoading ? "default" : "pointer", fontWeight: 600, opacity: synthLoading ? 0.7 : 1 }}>
                {synthLoading ? "Synthesizing…" : "Synthesize"}
              </button>
            </div>

            {synthResult && (
              <div style={{ marginBottom: 12, padding: "12px 16px", borderRadius: 10, background: "rgba(155,89,182,0.06)", border: "1px solid rgba(155,89,182,0.2)", fontSize: 13, color: COLORS.text, lineHeight: 1.7 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#9B59B6", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Thematic Synthesis</div>
                <Markdown text={synthResult} />
              </div>
            )}

            <div style={{ borderRadius: 12, border: "1px solid rgba(155,89,182,0.25)", overflow: "hidden", background: COLORS.paper }}>
              {researchQueue.map((e, idx) => (
                <div key={`${e.pdfName}-${e.id}`} style={{ padding: "10px 16px", borderTop: idx > 0 ? `1px solid ${COLORS.border}` : "none" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 11, color: "#9B59B6", fontWeight: 600, flexShrink: 0 }}>p.{e.pageNum}</span>
                    <span style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.5 }}>{e.question}</span>
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.pdfName}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Pop-out App ── */
// Rendered instead of App when ?mode=popout is in the URL.
// Receives annotation state via BroadcastChannel and sends user actions back.
export function PopoutApp() {
  const [annotation, setAnnotation] = useState(null);
  const [fileName, setFileName] = useState("");
  const bcRef = useRef(null);
  // Keep a ref so the BroadcastChannel handler always has current annotation id
  const annIdRef = useRef(null);
  annIdRef.current = annotation?.id;

  useEffect(() => {
    const bc = new BroadcastChannel("rc-sync");
    bcRef.current = bc;
    bc.onmessage = (e) => {
      const { type, ...data } = e.data;
      if (type === "popout-select" || type === "popout-update") {
        setAnnotation(data.annotation);
        if (data.fileName) setFileName(data.fileName);
      }
    };
    // Announce readiness; main window will send current annotation
    bc.postMessage({ type: "popout-ready" });
    window.addEventListener("beforeunload", () => bc.postMessage({ type: "popout-closed" }));
    return () => bc.close();
  }, []);

  const bc = () => bcRef.current;
  const send = (parentNodeId, msg) => bc()?.postMessage({ type: "popout-send", annId: annIdRef.current, parentNodeId, msg });
  const branchSel = (nodeId, childIdx) => bc()?.postMessage({ type: "popout-branch-select", annId: annIdRef.current, nodeId, childIdx });
  const noteChange = (note) => bc()?.postMessage({ type: "popout-note-change", annId: annIdRef.current, note });
  const resolveAnn = () => bc()?.postMessage({ type: "popout-resolve", annId: annIdRef.current });
  const deleteAnn = () => { bc()?.postMessage({ type: "popout-delete", annId: annIdRef.current }); setAnnotation(null); };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: COLORS.bg, fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ padding: "8px 16px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.paper, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>📎</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{fileName || "Reading Companion"}</span>
          <span style={{ fontSize: 11, color: COLORS.textMuted }}>— detail panel</span>
        </div>
        <button onClick={() => window.close()} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, cursor: "pointer" }}>Close</button>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        {annotation
          ? <DetailPanel annotation={annotation}
              onSend={send} onBranchSelect={branchSel} onNoteChange={noteChange}
              onSetFullActiveBranch={(newBranchAt) => bc()?.postMessage({ type: "popout-full-branch", annId: annIdRef.current, newBranchAt })}
              onResolve={resolveAnn} onDelete={deleteAnn}
              onClose={() => window.close()} />
          : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.textMuted, fontSize: 14, textAlign: "center", padding: 24 }}>
              Click a highlight in the main window to view it here.
            </div>}
      </div>
    </div>
  );
}

const ZOOM_STEP = 0.15;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

/* ── Main App ── */
export default function App() {
  const [pdf, setPdf] = useState(null);
  const [pageTexts, setPageTexts] = useState([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [popoverId, setPopoverId] = useState(null);
  const [popoverRect, setPopoverRect] = useState(null);
  const [rightPanel, setRightPanel] = useState("sidebar");
  const [containerWidth, setContainerWidth] = useState(0);
  const [selection, setSelection] = useState(null);
  const [hlColor, setHlColor] = useState("yellow");
  const [zoom, setZoom] = useState(1.0); // FIX 2: zoom state
  const [model, setModel] = useState(MODELS[2].id); // default: Opus
  const [readingMode, setReadingMode] = useState("general");
  const [knowledgeLog, setKnowledgeLog] = useState([]);
  const [history, setHistory] = useState(() => loadHistory());
  const [projects, setProjects] = useState([]);
  const projectsReadyRef = useRef(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const [showThumbs, setShowThumbs] = useState(true);
  const [thumbsWidth, setThumbsWidth] = useState(120);
  const [currentPage, setCurrentPage] = useState(1);
  const [layoutContainerWidth, setLayoutContainerWidth] = useState(0);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [popOutActive, setPopOutActive] = useState(false);
  const bcRef = useRef(null);
  const popOutWinRef = useRef(null); // reference to the pop-out window
  // Page input state: tracks what's typed in the page number field
  const [pageInput, setPageInput] = useState("1");
  const pageInputFocused = useRef(false);
  const panelDragRef = useRef(null);
  const thumbsDragRef = useRef(null);
  const isDraggingPanelRef = useRef(false);
  const isDraggingThumbsRef = useRef(false);
  const viewerRef = useRef(null);
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;
  const pendingScrollRef = useRef(null);       // zoom scroll correction
  const pendingResizeScrollRef = useRef(null); // resize/strip-toggle scroll anchor
  const containerWidthRef = useRef(0);         // previous containerWidth (sync, for ResizeObserver)
  const currentPageRef = useRef(1);            // sync mirror of currentPage state
  currentPageRef.current = currentPage;
  const zoomRef = useRef(zoom);                // sync mirror for wheel handler (avoid stale closure)
  zoomRef.current = zoom;

  // Split-view state (Item 25)
  const [pdf2, setPdf2] = useState(null);
  const [fileName2, setFileName2] = useState(null);
  const [annotations2, setAnnotations2] = useState([]);
  const [zoom2, setZoom2] = useState(1.0);
  const [activeId2, setActiveId2] = useState(null);
  const [activePanel, setActivePanel] = useState(1);
  const [showSplitPicker, setShowSplitPicker] = useState(false);
  const viewer2Ref = useRef(null);
  const [panel2Width, setPanel2Width] = useState(0);
  const [drawMode, setDrawMode] = useState(false);
  const drawDragRef = useRef(null); // { startX, startY, curX, curY, pageEl }
  const [drawDragDisplay, setDrawDragDisplay] = useState(null); // for rendering live rect

  // Zoom with viewport-center preservation
  const handleZoom = useCallback((newZoom) => {
    if (!viewerRef.current) { setZoom(newZoom); return; }
    const { scrollTop, clientHeight } = viewerRef.current;
    pendingScrollRef.current = { scrollTop, clientHeight, ratio: newZoom / zoom };
    setZoom(newZoom);
  }, [zoom]);

  useEffect(() => {
    if (!pendingScrollRef.current || !viewerRef.current) return;
    const { scrollTop, clientHeight, ratio } = pendingScrollRef.current;
    pendingScrollRef.current = null;
    const t = setTimeout(() => {
      if (viewerRef.current)
        viewerRef.current.scrollTop = (scrollTop + clientHeight / 2) * ratio - clientHeight / 2;
    }, 80);
    return () => clearTimeout(t);
  }, [zoom]);

  // Debounce the container width fed to PdfPage so Phase 1 (async dims) only runs
  // after a resize gesture fully settles — prevents pages from "bugging out" mid-drag.
  // Initial value (0→real) is applied immediately to avoid a 150ms blank-page delay.
  useEffect(() => {
    if (layoutContainerWidth === 0 && containerWidth > 0) {
      setLayoutContainerWidth(containerWidth);
      return;
    }
    const t = setTimeout(() => setLayoutContainerWidth(containerWidth), 150);
    return () => clearTimeout(t);
  }, [containerWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync pageInput to currentPage (from IntersectionObserver) when the field isn't focused
  useEffect(() => {
    if (!pageInputFocused.current) setPageInput(String(currentPage));
  }, [currentPage]);

  const startPanelDrag = useCallback((e) => {
    e.preventDefault();
    isDraggingPanelRef.current = true;
    panelDragRef.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    if (viewerRef.current) viewerRef.current.style.pointerEvents = "none";

    const move = (ev) => {
      const delta = panelDragRef.current.startX - ev.clientX;
      setPanelWidth(Math.max(280, Math.min(800, panelDragRef.current.startWidth + delta)));
    };
    const up = () => {
      isDraggingPanelRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (viewerRef.current) viewerRef.current.style.pointerEvents = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [panelWidth]);

  const startThumbsDrag = useCallback((e) => {
    e.preventDefault();
    isDraggingThumbsRef.current = true;
    thumbsDragRef.current = { startX: e.clientX, startWidth: thumbsWidth };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    if (viewerRef.current) viewerRef.current.style.pointerEvents = "none";
    const move = (ev) => {
      const delta = ev.clientX - thumbsDragRef.current.startX;
      setThumbsWidth(Math.max(80, Math.min(240, thumbsDragRef.current.startWidth + delta)));
    };
    const up = () => {
      isDraggingThumbsRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (viewerRef.current) viewerRef.current.style.pointerEvents = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [thumbsWidth]);

  // Scroll the PDF viewer so the annotation's highlight appears vertically centered
  const jumpToAnnotation = useCallback((ann) => {
    if (!viewerRef.current || !ann) return;
    const el = viewerRef.current.querySelector(`[data-page="${ann.pageNum}"]`);
    if (!el) return;
    // Estimate the Y position of the highlight within the page
    let annLocalY = el.offsetHeight * 0.3; // fallback: 30% down the page
    if (ann.mergedRects?.length) {
      const avgNorm = ann.mergedRects.reduce((s, r) => s + r.top, 0) / ann.mergedRects.length;
      // normalized [0,1] → CSS pixels; raw (legacy) rects are already CSS pixels
      annLocalY = ann.normalized ? avgNorm * el.offsetHeight : avgNorm;
    }
    const viewerH = viewerRef.current.clientHeight;
    viewerRef.current.scrollTo({ top: el.offsetTop + annLocalY - viewerH / 2, behavior: "smooth" });
  }, []);

  const activeAnn = activePanel === 2
    ? annotations2.find((a) => a.id === activeId2)
    : annotations.find((a) => a.id === activeId);
  const popoverAnn = annotations.find((a) => a.id === popoverId);

  // Persist annotations + keep history annotation count in sync
  useEffect(() => {
    if (!fileNameRef.current || !pdf) return;
    saveAnnotations(fileNameRef.current, annotations);
    setHistory(upsertHistory(fileNameRef.current, annotations.length));
  }, [annotations, pdf]);

  // Knowledge log: load when file changes (try server first), save when log changes
  useEffect(() => {
    if (!fileName) { setKnowledgeLog([]); return; }
    (async () => {
      try {
        const fromServer = await fetch(`/api/klog/${sanitizeForUrl(fileName)}`)
          .then((r) => r.ok ? r.json() : null).catch(() => null);
        if (fromServer?.data?.length) { setKnowledgeLog(fromServer.data); return; }
        const raw = localStorage.getItem(storageKey(`klog:${fileName}`));
        setKnowledgeLog(raw ? JSON.parse(raw) : []);
      } catch { setKnowledgeLog([]); }
    })();
  }, [fileName]);
  useEffect(() => {
    if (!fileName) return;
    try { localStorage.setItem(storageKey(`klog:${fileName}`), JSON.stringify(knowledgeLog)); } catch {}
    fetch(`/api/klog/${sanitizeForUrl(fileName)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(knowledgeLog),
    }).catch(() => {});
  }, [knowledgeLog, fileName]);

  // Projects: load once from server on mount, save whenever changed
  useEffect(() => {
    fetch("/api/projects").then((r) => r.ok ? r.json() : null).catch(() => null)
      .then((data) => { setProjects(data?.projects ?? []); projectsReadyRef.current = true; });
  }, []);
  useEffect(() => {
    if (!projectsReadyRef.current) return;
    fetch("/api/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(projects) }).catch(() => {});
  }, [projects]);

  // ── BroadcastChannel for pop-out panel ──
  // Set up the channel once; use a ref-based handler to avoid stale closures.
  const bcHandlerRef = useRef(null);
  useEffect(() => {
    const bc = new BroadcastChannel("rc-sync");
    bcRef.current = bc;
    bc.onmessage = (e) => bcHandlerRef.current?.(e);
    return () => { bc.close(); bcRef.current = null; };
  }, []);

  // Handler is reassigned every render so it always has fresh state/callbacks.
  bcHandlerRef.current = (e) => {
    const { type, ...data } = e.data;
    if (type === "popout-ready") {
      // Pop-out just opened — send it the currently selected annotation
      const ann = annotations.find((a) => a.id === activeId);
      if (ann) bcRef.current?.postMessage({ type: "popout-select", annotation: ann, fileName });
    } else if (type === "popout-send") {
      sendMessage(data.annId, data.parentNodeId, data.msg);
    } else if (type === "popout-branch-select") {
      updateActiveBranch(data.annId, data.nodeId, data.childIdx);
    } else if (type === "popout-full-branch") {
      setFullActiveBranch(data.annId, data.newBranchAt);
    } else if (type === "popout-note-change") {
      updateNote(data.annId, data.note);
    } else if (type === "popout-resolve") {
      resolve(data.annId);
    } else if (type === "popout-delete") {
      deleteAnn(data.annId);
    } else if (type === "popout-closed") {
      setPopOutActive(false);
      popOutWinRef.current = null;
    }
  };

  // Whenever the active annotation changes or updates, push it to the pop-out.
  useEffect(() => {
    if (!popOutActive || !bcRef.current) return;
    const ann = annotations.find((a) => a.id === activeId);
    if (ann) bcRef.current.postMessage({ type: "popout-update", annotation: ann, fileName });
  }, [annotations, activeId, popOutActive, fileName]);

  const openPopOut = () => {
    // If already open, focus it instead of opening a new one
    if (popOutWinRef.current && !popOutWinRef.current.closed) {
      popOutWinRef.current.focus(); return;
    }
    const w = window.open(`${window.location.pathname}?mode=popout`, "rc-popout",
      "width=520,height=800,menubar=no,toolbar=no,location=no,status=no");
    popOutWinRef.current = w;
    setPopOutActive(true);
    // Poll to detect if the pop-out was closed via the OS X button
    const poll = setInterval(() => {
      if (!popOutWinRef.current || popOutWinRef.current.closed) {
        setPopOutActive(false); popOutWinRef.current = null; clearInterval(poll);
      }
    }, 1000);
  };

  const closePopOut = () => {
    popOutWinRef.current?.close();
    popOutWinRef.current = null;
    setPopOutActive(false);
  };

  useEffect(() => {
    if (!viewerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      // Don't update containerWidth during panel or thumbnail strip drag — pages would
      // momentarily resize mid-gesture. layoutContainerWidth debounce handles the final
      // reflow cleanly once the drag stops.
      if (isDraggingPanelRef.current || isDraggingThumbsRef.current) return;
      for (const e of entries) {
        const newWidth = e.contentRect.width;
        // Save anchor only once per gesture — don't overwrite mid-resize so the original
        // reading position is preserved even during rapid continuous resize callbacks.
        if (!pendingResizeScrollRef.current && containerWidthRef.current > 0 && viewerRef.current) {
          const pageNum = currentPageRef.current;
          const el = viewerRef.current.querySelector(`[data-page="${pageNum}"]`);
          if (el && el.offsetHeight > 0) {
            const fraction = (viewerRef.current.scrollTop - el.offsetTop) / el.offsetHeight;
            pendingResizeScrollRef.current = { pageNum, fraction };
          }
        }
        containerWidthRef.current = newWidth;
        setContainerWidth(newWidth);
      }
    });
    ro.observe(viewerRef.current);
    return () => ro.disconnect();
  }, [pdf]);

  // Panel 2 width tracking for split view
  useEffect(() => {
    if (!viewer2Ref.current || !pdf2) return;
    const ro2 = new ResizeObserver(([e]) => setPanel2Width(e.contentRect.width));
    ro2.observe(viewer2Ref.current);
    return () => ro2.disconnect();
  }, [pdf2]);

  // Restore scroll anchor after Phase 1 (async dims) settles.
  // layoutContainerWidth only updates 150ms after the last containerWidth change, so by
  // the time this effect fires all page heights are at their final values.
  // An additional 80ms timeout lets the browser measure new offsetHeights before we scroll.
  useEffect(() => {
    if (!pendingResizeScrollRef.current) return;
    const { pageNum, fraction } = pendingResizeScrollRef.current;
    const t = setTimeout(() => {
      pendingResizeScrollRef.current = null;
      if (!viewerRef.current) return;
      const el = viewerRef.current.querySelector(`[data-page="${pageNum}"]`);
      if (el) viewerRef.current.scrollTop = el.offsetTop + fraction * el.offsetHeight;
    }, 80);
    return () => clearTimeout(t);
  }, [layoutContainerWidth]);

  // Track which page is most visible in the viewer (drives thumbnail strip highlight + scroll).
  // Depends on layoutContainerWidth (not raw containerWidth) so it re-observes after layout settles.
  useEffect(() => {
    if (!pdf || !viewerRef.current || layoutContainerWidth <= 0) return;
    const visibleRatios = new Map();
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const num = parseInt(e.target.dataset.page);
        visibleRatios.set(num, e.isIntersecting ? e.intersectionRatio : 0);
      });
      let bestPage = 1, bestRatio = -1;
      visibleRatios.forEach((ratio, page) => { if (ratio > bestRatio) { bestRatio = ratio; bestPage = page; } });
      if (bestRatio > 0) setCurrentPage(bestPage);
    }, { root: viewerRef.current, threshold: [0, 0.1, 0.5, 1.0] });
    viewerRef.current.querySelectorAll("[data-page]").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [pdf, layoutContainerWidth]);

  // Jump viewer to a specific page number (used by thumbnail strip clicks)
  const jumpToPage = useCallback((pageNum) => {
    const el = viewerRef.current?.querySelector(`[data-page="${pageNum}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      // Zoom: Cmd/Ctrl + / -
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        handleZoom(Math.min(MAX_ZOOM, parseFloat((zoom + ZOOM_STEP).toFixed(2))));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        handleZoom(Math.max(MIN_ZOOM, parseFloat((zoom - ZOOM_STEP).toFixed(2))));
        return;
      }
      if (!selection) return;
      if (e.key === "h" || e.key === "H") { e.preventDefault(); doHighlight(); }
      if (e.key === "c" || e.key === "C") { e.preventDefault(); doAskClaude(); }
      if (e.key === "Escape") { window.getSelection()?.removeAllRanges(); setSelection(null); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // Pinch-to-zoom: macOS trackpad sends wheel events with ctrlKey=true for pinch gestures.
  // Uses zoomRef (not zoom state) so the handler is always computing from the latest value
  // even as events fire faster than React renders. passive:false is required for preventDefault.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const handler = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.008;
      const next = parseFloat(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current + delta)).toFixed(2));
      if (next !== zoomRef.current) {
        zoomRef.current = next; // update immediately so next event reads fresh value
        setZoom(next);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [pdf]); // re-attach when pdf changes (viewerRef content is ready)

  // Split-view: load a second PDF (read-only, uses IDB cache)
  const loadPdf2 = async (name) => {
    try {
      const buffer = await loadPdfIDB(name);
      if (!buffer) { alert(`"${name}" not in local storage. Open it first so it gets cached.`); return; }
      const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
      const fromServer = await fetch(`/api/annotations/${sanitizeForUrl(name)}`)
        .then((r) => r.ok ? r.json() : null).catch(() => null);
      const saved = fromServer?.data?.length ? fromServer.data : loadAnnotationsFromStorage(name);
      const loaded = saved
        ? saved.filter((a) => !a.loading).map((a) => a.msgRoot ? a : { ...a, msgRoot: linearToTree(a.messages || []) })
        : [];
      setPdf2(pdfDoc);
      setFileName2(name);
      setAnnotations2(loaded);
      setZoom2(zoom);
      setActiveId2(null);
      setActivePanel(2);
      setShowSplitPicker(false);
    } catch (e) { console.error("loadPdf2:", e); }
  };

  const closePdf2 = () => {
    setPdf2(null); setFileName2(null); setAnnotations2([]); setZoom2(1.0);
    setActiveId2(null); setActivePanel(1); setPanel2Width(0);
  };

  // FIX 4: show PDF immediately, extract text in background
  const handleUpload = async (arrayBuffer, name) => {
    setLoading(true); setLoadError(null);
    // Save to IDB before PDF.js can transfer/detach the ArrayBuffer to its worker
    savePdfIDB(name, arrayBuffer);
    try {
      const lib = await loadPdfJs();
      const pdfDoc = await lib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      // Unblock the UI immediately
      setPdf(pdfDoc); setFileName(name);
      // Load annotations: server first (survives cache clears), fall back to localStorage
      const fromServer = await fetch(`/api/annotations/${sanitizeForUrl(name)}`)
        .then((r) => r.ok ? r.json() : null).catch(() => null);
      const saved = fromServer?.data?.length ? fromServer.data : loadAnnotationsFromStorage(name);
      setAnnotations(saved.map((a) => ({ ...a, loading: false })));
      setHistory(upsertHistory(name, saved.length));
      setLoading(false);
      // Extract text for Claude context in the background
      const texts = new Array(pdfDoc.numPages).fill("");
      setPageTexts(texts);
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const content = await page.getTextContent();
        texts[i - 1] = content.items.map((it) => it.str).join(" ");
        // Flush to React state every 10 pages so Claude gets context progressively
        if (i % 10 === 0 || i === pdfDoc.numPages) setPageTexts([...texts]);
      }
    } catch (e) { setLoadError(`Failed to load "${name}": ${e.message}.`); setLoading(false); }
  };

  // Viewer-level mouseup: handles both single-page and cross-page selections.
  // Finds the page with the most selected rects (dominant page), clips rects to it,
  // and captures a screenshot from that page's canvas.
  const handleViewerMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;
    const range = sel.getRangeAt(0);
    const allRects = Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1);
    if (!allRects.length) return;

    const pageEls = viewerRef.current?.querySelectorAll("[data-page]");
    if (!pageEls?.length) return;

    // Find the page with the most overlapping selection rects
    let bestEl = null, bestCount = 0;
    pageEls.forEach(el => {
      const wr = el.getBoundingClientRect();
      const count = allRects.filter(r => r.bottom > wr.top && r.top < wr.bottom).length;
      if (count > bestCount) { bestCount = count; bestEl = el; }
    });
    if (!bestEl) return;

    const pageNum = parseInt(bestEl.dataset.page);
    const canvas = bestEl.querySelector("canvas");
    const wr = bestEl.getBoundingClientRect();
    const cssW = parseFloat(canvas?.style.width || "0");
    const dpr = canvas && canvas.width > 0 && cssW > 0 ? canvas.width / cssW : (window.devicePixelRatio || 1);

    // Use center-point containment so rects that merely graze the page boundary are excluded
    const pageRects = allRects.filter(r => { const mid = (r.top + r.bottom) / 2; return mid > wr.top && mid < wr.bottom; });
    const merged = mergeRects(pageRects, wr);
    if (!merged.length) return;

    const screenshot = canvas && canvas.width > 0 ? captureRegion(canvas, merged, dpr) : null;

    // Normalize rects to [0,1] of page CSS dimensions so they stay correct at any zoom/width.
    // If the canvas isn't painted yet (Phase 3 not run), fall back to the wrapper's offsetWidth/Height,
    // which Phase 1 already set to the correct dimensions via setDims → width: dims.w.
    const pageW = parseFloat(canvas?.style.width || "0") || bestEl.offsetWidth;
    const pageH = parseFloat(canvas?.style.height || "0") || bestEl.offsetHeight;
    const normalized = pageW > 0 && pageH > 0;
    const storedRects = normalized
      ? merged.map(r => ({ left: r.left / pageW, top: r.top / pageH, width: r.width / pageW, height: r.height / pageH }))
      : merged;

    setSelection({ text, mergedRects: storedRects, normalized, screenshot, toolbarRect: range.getBoundingClientRect(), pageNum });
    // Don't clear the browser selection here — leave it visible so the user can see what they selected.
    // It gets cleared when they commit (H / C) or dismiss (Escape / click away).
  }, []);

  const doHighlight = useCallback(() => {
    if (!selection) return;
    window.getSelection()?.removeAllRanges();
    setAnnotations((prev) => [...prev, {
      id: `ann-${Date.now()}`, pageNum: selection.pageNum, rawText: selection.text,
      mergedRects: selection.mergedRects, normalized: selection.normalized, screenshot: selection.screenshot,
      type: "highlight", color: hlColor, note: "", messages: [], status: "active", loading: false,
    }]);
    setSelection(null);
  }, [selection, hlColor]);

  const doAskClaude = useCallback(() => {
    if (!selection) return;
    window.getSelection()?.removeAllRanges();
    const id = `ann-${Date.now()}`;
    const content = [];
    if (selection.screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: selection.screenshot } });
    const modeInstruction = readingMode === "academic"
      ? "Analyze this passage critically."
      : readingMode === "newcomer"
        ? "Explain this passage simply, as if to someone new to the subject."
        : "Identify the passage and explain it clearly in 2-4 sentences.";
    // A4: detect author-year citations in the highlighted text and the full page text
    const pageText = pageTexts[selection.pageNum - 1] || "";
    const citations = detectCitations(selection.text + " " + pageText);
    const citationNote = citations.length > 0
      ? `\n\nDetected citations on this page: ${citations.join(", ")}`
      : "";
    const textPart = selection.text
      ? `Raw extracted text: "${selection.text}"`
      : "No text was automatically extracted (this may be a scanned or image-based PDF). Please read and analyze the image directly.";
    content.push({ type: "text", text: `The user selected a region on page ${selection.pageNum}. Above is the screenshot of the selected area. ${textPart}\n\n${modeInstruction}${citationNote}` });
    const rootNodeId = mkNodeId();
    const rootNode = { id: rootNodeId, role: "user", content, children: [] };
    setAnnotations((prev) => [...prev, {
      id, pageNum: selection.pageNum, rawText: selection.text,
      mergedRects: selection.mergedRects, normalized: selection.normalized, screenshot: selection.screenshot,
      type: "claude", color: hlColor, note: "", msgRoot: rootNode, activeBranchAt: {}, status: "active", loading: true,
    }]);
    setPopoverId(id); setPopoverRect(selection.toolbarRect); setSelection(null);

    const sys = buildSystemPrompt(pageTexts, annotations, selection.pageNum, readingMode);
    callClaude(sys, [{ role: "user", content }], model).then((resp) => {
      const aNodeId = mkNodeId();
      const aNode = { id: aNodeId, role: "assistant", content: resp, children: [] };
      setAnnotations((prev) => prev.map((a) => a.id === id
        ? { ...a, loading: false, msgRoot: { ...a.msgRoot, children: [aNode] } }
        : a));
    }).catch((err) => {
      const aNodeId = mkNodeId();
      const aNode = { id: aNodeId, role: "assistant", content: `Error: ${err.message}`, isError: true, children: [] };
      setAnnotations((prev) => prev.map((a) => a.id === id
        ? { ...a, loading: false, msgRoot: { ...a.msgRoot, children: [aNode] } }
        : a));
    });
  }, [selection, hlColor, pageTexts, annotations, readingMode]);

  const doAddResearchQ = useCallback((question) => {
    if (!selection) return;
    window.getSelection()?.removeAllRanges();
    setAnnotations((prev) => [...prev, {
      id: `ann-${Date.now()}`, pageNum: selection.pageNum, rawText: selection.text,
      question, mergedRects: selection.mergedRects, normalized: selection.normalized,
      type: "research", color: "yellow", note: "", status: "active",
    }]);
    setSelection(null);
  }, [selection]);

  // Draw mode: freehand rectangle selection for scanned/image PDFs
  const handleDrawStart = useCallback((e) => {
    const pageEls = viewerRef.current?.querySelectorAll("[data-page]");
    if (!pageEls) return;
    let pageEl = null;
    for (const el of pageEls) {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        pageEl = el; break;
      }
    }
    if (!pageEl) return;
    e.preventDefault();
    const drag = { startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, pageEl };
    drawDragRef.current = drag;
    setDrawDragDisplay(drag);
  }, []);

  const handleDrawEnd = useCallback(() => {
    const drag = drawDragRef.current;
    drawDragRef.current = null;
    setDrawDragDisplay(null);
    if (!drag) return;
    const { startX, startY, curX, curY, pageEl } = drag;
    const dx = Math.abs(curX - startX), dy = Math.abs(curY - startY);
    if (dx < 8 || dy < 8) return;
    const wr = pageEl.getBoundingClientRect();
    const canvas = pageEl.querySelector("canvas");
    const cssW = parseFloat(canvas?.style.width || "0");
    const dpr = canvas && canvas.width > 0 && cssW > 0 ? canvas.width / cssW : (window.devicePixelRatio || 1);
    const rect = { left: Math.min(startX, curX) - wr.left, top: Math.min(startY, curY) - wr.top, width: dx, height: dy };
    const screenshot = canvas && canvas.width > 0 ? captureRegion(canvas, [rect], dpr) : null;
    const pageNum = parseInt(pageEl.dataset.page);
    const pageW = parseFloat(canvas?.style.width || "0") || pageEl.offsetWidth;
    const pageH = parseFloat(canvas?.style.height || "0") || pageEl.offsetHeight;
    const normalized = pageW > 0 && pageH > 0;
    const storedRects = normalized
      ? [{ left: rect.left / pageW, top: rect.top / pageH, width: rect.width / pageW, height: rect.height / pageH }]
      : [rect];
    const toolbarRect = { left: Math.min(startX, curX), top: Math.min(startY, curY), bottom: Math.max(startY, curY), width: dx };
    setSelection({ text: "", mergedRects: storedRects, normalized, screenshot, toolbarRect, pageNum });
  }, []);

  // While a draw drag is active, track mouse globally (handles drag outside viewer)
  useEffect(() => {
    if (!drawDragDisplay) return;
    const onMove = (e) => {
      const updated = { ...drawDragRef.current, curX: e.clientX, curY: e.clientY };
      drawDragRef.current = updated;
      setDrawDragDisplay({ ...updated });
    };
    const onUp = () => handleDrawEnd();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [!!drawDragDisplay, handleDrawEnd]);

  // sendMessage: adds a user node as a child of parentNodeId, calls Claude,
  // then adds the assistant response as a child of that user node.
  // Switches the active branch to the new user node (even if parentNodeId already has children).
  const sendMessage = useCallback((annId, parentNodeId, msg) => {
    const ann = annotations.find((a) => a.id === annId);
    if (!ann) return;
    const uNodeId = mkNodeId();
    const uNode = { id: uNodeId, role: "user", content: msg, children: [] };
    const newRoot = addNodeToTree(ann.msgRoot, parentNodeId, uNode);
    // Point activeBranchAt[parentNodeId] to the new child (last child of that node)
    const parentAfter = findNode(newRoot, parentNodeId);
    const branchIdx = parentAfter.children.length - 1;
    const newBranchAt = { ...ann.activeBranchAt, [parentNodeId]: branchIdx };
    setAnnotations((prev) => prev.map((a) => a.id === annId
      ? { ...a, loading: true, msgRoot: newRoot, activeBranchAt: newBranchAt }
      : a));
    // Pass the full active path (root → new user node) as context to Claude.
    // Item 19+20: classify the question — general knowledge gets a narrow doc slice (3K chars)
    // so we don't burn tokens sending unrelated pages; paper-specific gets full context (30K).
    const pathMsgs = getPathMessages(newRoot, newBranchAt);
    const qType = classifyQuestion(msg);
    const docChars = qType === "general" ? 3000 : 30000;
    const sys = buildSystemPrompt(pageTexts, annotations.filter((a) => a.id !== annId), ann.pageNum, readingMode, docChars);
    callClaude(sys, pathMsgs, model).then((resp) => {
      const aNodeId = mkNodeId();
      const aNode = { id: aNodeId, role: "assistant", content: resp, children: [] };
      setAnnotations((prev) => prev.map((a) => {
        if (a.id !== annId) return a;
        return { ...a, loading: false, msgRoot: addNodeToTree(a.msgRoot, uNodeId, aNode) };
      }));
    }).catch((err) => {
      const aNodeId = mkNodeId();
      const aNode = { id: aNodeId, role: "assistant", content: `Error: ${err.message}`, isError: true, children: [] };
      setAnnotations((prev) => prev.map((a) => {
        if (a.id !== annId) return a;
        return { ...a, loading: false, msgRoot: addNodeToTree(a.msgRoot, uNodeId, aNode) };
      }));
    });
  }, [pageTexts, annotations, model, readingMode]);

  const updateActiveBranch = useCallback((annId, nodeId, childIdx) => {
    setAnnotations((prev) => prev.map((a) => a.id === annId
      ? { ...a, activeBranchAt: { ...a.activeBranchAt, [nodeId]: childIdx } }
      : a));
  }, []);

  // Sets the full activeBranchAt map atomically (used by tree-mode node selection
  // when activating a node may require re-routing multiple fork points at once).
  const setFullActiveBranch = useCallback((annId, newBranchAt) => {
    setAnnotations((prev) => prev.map((a) => a.id === annId
      ? { ...a, activeBranchAt: newBranchAt }
      : a));
  }, []);

  const resolve = (id) => {
    setAnnotations((prev) => prev.map((a) => a.id === id ? { ...a, status: "resolved" } : a));
    setPopoverId(null); setPopoverRect(null);
    if (activeId === id) { setActiveId(null); setRightPanel("sidebar"); }
  };

  const deleteAnn = (id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setKnowledgeLog((prev) => prev.filter((e) => e.annId !== id));
    if (popoverId === id) { setPopoverId(null); setPopoverRect(null); }
    if (activeId === id) { setActiveId(null); setRightPanel("sidebar"); }
  };

  const updateNote = (id, note) => {
    setAnnotations((prev) => prev.map((a) => a.id === id ? { ...a, note } : a));
  };

  const toggleLogEntry = useCallback((annId, nodeId, text, pageNum) => {
    setKnowledgeLog((prev) => {
      const exists = prev.find((e) => e.nodeId === nodeId);
      if (exists) return prev.filter((e) => e.nodeId !== nodeId);
      return [...prev, { id: `kl-${Date.now()}`, annId, nodeId, text: text.slice(0, 400), pageNum, ts: Date.now() }];
    });
  }, []);

  const selectLogEntry = useCallback((annId) => {
    setActiveId(annId);
    setRightPanel("detail");
    const ann = annotations.find((a) => a.id === annId);
    if (ann) jumpToAnnotation(ann);
  }, [annotations, jumpToAnnotation]);

  useEffect(() => {
    const h = (e) => {
      if (selection && !e.target.closest("[data-toolbar]")) { window.getSelection()?.removeAllRanges(); setSelection(null); }
      if (popoverId && !e.target.closest("[data-popover]")) { setPopoverId(null); setPopoverRect(null); }
      if (showExportMenu && !e.target.closest("[data-export-menu]")) setShowExportMenu(false);
      if (showSplitPicker && !e.target.closest("[data-split-picker]")) setShowSplitPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [selection, popoverId, showExportMenu]);

  // Extract text content from a message (content may be a string or a content-block array)
  const msgText = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    return "";
  };

  const exportMarkdown = () => {
    if (!annotations.length) return;
    const lines = [`# Annotations: ${fileName}`, ""];
    annotations.forEach((ann, i) => {
      const color = ann.color ? ann.color.charAt(0).toUpperCase() + ann.color.slice(1) : "Yellow";
      const typeLabel = ann.type === "claude" ? "Claude annotation" : "Highlight";
      lines.push(`## ${i + 1}. Page ${ann.pageNum} · ${color} ${typeLabel}`, "");
      if (ann.rawText) lines.push(`> ${ann.rawText.replace(/\n/g, "\n> ")}`, "");
      if (ann.note) lines.push(`**Note:** ${ann.note}`, "");
      // Traverse the active path (skip root auto-prompt node)
      const path = ann.msgRoot ? getActivePath(ann.msgRoot, ann.activeBranchAt).slice(1) : [];
      if (path.length) {
        lines.push("**Thread:**", "");
        path.forEach((node) => {
          const speaker = node.role === "user" ? "**You:**" : "**Claude:**";
          const text = msgText(node.content);
          lines.push(`${speaker} ${text}`, "");
        });
      }
      lines.push("---", "");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${fileName.replace(/\.pdf$/i, "")}-annotations.md`; a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const exportJson = () => {
    if (!annotations.length) return;
    const data = annotations.map(({ screenshot, loading, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${fileName.replace(/\.pdf$/i, "")}-annotations.json`; a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const exportAnki = () => {
    const cards = annotations
      .filter((ann) => ann.type === "claude" && ann.rawText && ann.msgRoot?.children?.length > 0)
      .map((ann) => {
        const front = ann.rawText.replace(/\t/g, " ").replace(/\n/g, " ").trim();
        const firstAsst = ann.msgRoot.children[0];
        const back = msgText(firstAsst?.content).replace(/\t/g, " ").replace(/\n/g, " ").trim();
        return `${front}\t${back}`;
      });
    if (!cards.length) return;
    const blob = new Blob([cards.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${fileName.replace(/\.pdf$/i, "")}-anki.txt`; a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  if (!pdf) return (
    <UploadScreen onUpload={handleUpload} loading={loading} error={loadError}
      history={history}
      onRemoveHistory={(name) => setHistory(removeFromHistory(name))}
      projects={projects}
      onProjectsChange={setProjects} />
  );

  const pageNums = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  // Responsive header: containerWidth already tracks the main column width.
  // isCompact: hide ▦ toggle, use short model labels, tighten gaps
  // isTiny:    also hide model selector entirely
  const isCompact = containerWidth > 0 && containerWidth < 520;
  const isTiny    = containerWidth > 0 && containerWidth < 360;

  return (
    <div style={{ display: "flex", height: "100vh", background: COLORS.bg, overflow: "hidden" }}>
      {showThumbs && pdf && (
        <ThumbnailStrip pdf={pdf} numPages={pdf.numPages} currentPage={currentPage}
          onJumpToPage={jumpToPage} width={thumbsWidth}
          onResizeDrag={startThumbsDrag} onClose={() => setShowThumbs(false)} />
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: "8px 16px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.paper, display: "flex", alignItems: "center", gap: 8, flexShrink: 0, overflow: "hidden" }}>
          {/* Left: file info — shrinks first, filename truncates */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, overflow: "hidden" }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>📖</span>
            <div style={{ minWidth: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</div>
              {!isTiny && <div style={{ fontSize: 11, color: COLORS.textMuted }}>{pdf.numPages} pages · {annotations.length} annotations</div>}
            </div>
          </div>
          {/* Right: controls — flexShrink: 0 keeps them from collapsing */}
          <div style={{ display: "flex", alignItems: "center", gap: isCompact ? 6 : 12, flexShrink: 0 }}>
            {/* Thumbnail toggle — hidden when compact (strip's own × button still works) */}
            {!isCompact && (
              <button onClick={() => setShowThumbs((v) => !v)} title={showThumbs ? "Hide thumbnails" : "Show thumbnails"}
                style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${COLORS.border}`, background: showThumbs ? COLORS.accentLight : "none", cursor: "pointer", fontSize: 13, color: showThumbs ? COLORS.accent : COLORS.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>
                ▦
              </button>
            )}
            {/* Page navigation: prev / [input] / total / next */}
            {!isTiny && (
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                {!isCompact && (
                  <button onClick={() => jumpToPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} title="Previous page"
                    style={{ width: 22, height: 22, borderRadius: 5, border: `1px solid ${COLORS.border}`, background: "none", cursor: currentPage <= 1 ? "default" : "pointer", fontSize: 13, color: currentPage <= 1 ? COLORS.border : COLORS.text, display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
                )}
                <input
                  type="number" min={1} max={pdf.numPages}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onFocus={() => { pageInputFocused.current = true; }}
                  onBlur={() => {
                    pageInputFocused.current = false;
                    const n = parseInt(pageInput);
                    if (!isNaN(n) && n >= 1 && n <= pdf.numPages) jumpToPage(n);
                    else setPageInput(String(currentPage));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { const n = parseInt(pageInput); if (!isNaN(n) && n >= 1 && n <= pdf.numPages) jumpToPage(n); e.currentTarget.blur(); }
                    if (e.key === "Escape") { setPageInput(String(currentPage)); e.currentTarget.blur(); }
                  }}
                  style={{ width: 36, textAlign: "center", border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "3px 2px", fontSize: 12, color: COLORS.text, background: COLORS.paper, outline: "none", MozAppearance: "textfield" }}
                />
                <span style={{ fontSize: 11, color: COLORS.textMuted, whiteSpace: "nowrap" }}>/ {pdf.numPages}</span>
                {!isCompact && (
                  <button onClick={() => jumpToPage(Math.min(pdf.numPages, currentPage + 1))} disabled={currentPage >= pdf.numPages} title="Next page"
                    style={{ width: 22, height: 22, borderRadius: 5, border: `1px solid ${COLORS.border}`, background: "none", cursor: currentPage >= pdf.numPages ? "default" : "pointer", fontSize: 13, color: currentPage >= pdf.numPages ? COLORS.border : COLORS.text, display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
                )}
              </div>
            )}
            {/* Model selector — hidden when tiny, abbreviated when compact */}
            {!isTiny && (
              <div style={{ display: "flex", alignItems: "center", gap: 1, border: `1px solid ${COLORS.border}`, borderRadius: 8, overflow: "hidden" }}>
                {MODELS.map((m) => (
                  <button key={m.id} onClick={() => setModel(m.id)} title={m.desc}
                    style={{ padding: isCompact ? "5px 7px" : "5px 11px", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", background: model === m.id ? COLORS.accent : "none", color: model === m.id ? "#fff" : COLORS.textMuted, transition: "background 0.12s, color 0.12s" }}>
                    {isCompact ? m.short : m.label}
                  </button>
                ))}
              </div>
            )}
            {/* Reading mode selector — hidden when tiny */}
            {!isTiny && (
              <div style={{ display: "flex", alignItems: "center", gap: 1, border: `1px solid ${COLORS.border}`, borderRadius: 8, overflow: "hidden" }}>
                {READING_MODES.map((m) => (
                  <button key={m.id} onClick={() => setReadingMode(m.id)} title={m.desc}
                    style={{ padding: isCompact ? "5px 7px" : "5px 11px", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", background: readingMode === m.id ? "#6B9E78" : "none", color: readingMode === m.id ? "#fff" : COLORS.textMuted, transition: "background 0.12s, color 0.12s" }}>
                    {isCompact ? m.short : m.label}
                  </button>
                ))}
              </div>
            )}
            {/* Zoom controls — always visible */}
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button onClick={() => handleZoom(Math.max(MIN_ZOOM, parseFloat((zoom - ZOOM_STEP).toFixed(2))))} title="Zoom out (⌘-)"
                style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", cursor: "pointer", fontSize: 16, color: COLORS.text, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
              <span style={{ fontSize: 12, minWidth: 38, textAlign: "center", color: COLORS.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => handleZoom(Math.min(MAX_ZOOM, parseFloat((zoom + ZOOM_STEP).toFixed(2))))} title="Zoom in (⌘=)"
                style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", cursor: "pointer", fontSize: 16, color: COLORS.text, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            </div>
            {/* Draw mode toggle — for scanned/image PDFs */}
            <button onClick={() => { setDrawMode((d) => !d); setSelection(null); }}
              title={drawMode ? "Exit draw mode (click to toggle)" : "Draw mode — drag to select regions on scanned PDFs"}
              style={{ fontSize: 12, padding: isCompact ? "5px 8px" : "5px 12px", borderRadius: 8, border: `1px solid ${drawMode ? "#9B59B6" : COLORS.border}`, background: drawMode ? "rgba(155,89,182,0.12)" : "none", color: drawMode ? "#9B59B6" : COLORS.textMuted, cursor: "pointer", whiteSpace: "nowrap", fontWeight: drawMode ? 600 : 400 }}>
              {isTiny ? "✏" : "Draw"}
            </button>
            {/* Export button — hidden when tiny or no annotations */}
            {!isTiny && annotations.length > 0 && (
              <div style={{ position: "relative" }} data-export-menu>
                <button onClick={() => setShowExportMenu((v) => !v)}
                  title="Export annotations"
                  style={{ fontSize: 12, padding: isCompact ? "5px 8px" : "5px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: showExportMenu ? COLORS.accentLight : "none", color: showExportMenu ? COLORS.accent : COLORS.textMuted, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 3 }}>
                  {isCompact ? "↓" : "Export"} <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
                </button>
                {showExportMenu && (
                  <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: COLORS.paper, border: `1px solid ${COLORS.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.10)", zIndex: 100, minWidth: 140, overflow: "hidden", animation: "popIn 0.1s ease" }}>
                    <button onClick={exportMarkdown} style={{ display: "block", width: "100%", padding: "9px 14px", fontSize: 12, border: "none", background: "none", textAlign: "left", cursor: "pointer", color: COLORS.text }}
                      onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                      onMouseLeave={(e) => e.currentTarget.style.background = "none"}>
                      Markdown (.md)
                    </button>
                    <button onClick={exportJson} style={{ display: "block", width: "100%", padding: "9px 14px", fontSize: 12, border: "none", background: "none", textAlign: "left", cursor: "pointer", color: COLORS.text, borderTop: `1px solid ${COLORS.border}` }}
                      onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                      onMouseLeave={(e) => e.currentTarget.style.background = "none"}>
                      JSON (.json)
                    </button>
                    <button onClick={exportAnki} style={{ display: "block", width: "100%", padding: "9px 14px", fontSize: 12, border: "none", background: "none", textAlign: "left", cursor: "pointer", color: COLORS.text, borderTop: `1px solid ${COLORS.border}` }}
                      onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                      onMouseLeave={(e) => e.currentTarget.style.background = "none"}>
                      Anki (.txt)
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* Compare / close split — hidden when tiny */}
            {!isTiny && (
              <button data-split-picker onClick={() => pdf2 ? closePdf2() : setShowSplitPicker((v) => !v)}
                title={pdf2 ? "Close comparison view" : "Compare with another PDF side-by-side"}
                style={{ fontSize: 12, padding: isCompact ? "5px 8px" : "5px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: pdf2 || showSplitPicker ? COLORS.accentLight : "none", color: pdf2 || showSplitPicker ? COLORS.accent : COLORS.textMuted, cursor: "pointer", whiteSpace: "nowrap", position: "relative" }}>
                {pdf2 ? (isCompact ? "⊡" : "Close split") : (isCompact ? "⊞" : "Compare")}
                {/* Split picker dropdown */}
                {showSplitPicker && !pdf2 && (
                  <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: COLORS.paper, border: `1px solid ${COLORS.border}`, borderRadius: 10, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 200, minWidth: 240, maxHeight: 260, overflowY: "auto", textAlign: "left" }}
                    onClick={(e) => e.stopPropagation()}>
                    <div style={{ padding: "10px 14px 6px", fontSize: 11, fontWeight: 600, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Compare with</div>
                    {history.filter((h) => h.name !== fileName).length === 0 ? (
                      <div style={{ padding: "10px 14px", fontSize: 12, color: COLORS.textMuted }}>No other PDFs in history. Open another PDF first.</div>
                    ) : history.filter((h) => h.name !== fileName).map((h, hi, arr) => (
                      <button key={h.name} onClick={() => { loadPdf2(h.name); setShowSplitPicker(false); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", background: "none", border: "none", borderTop: hi > 0 ? `1px solid ${COLORS.border}` : "none", cursor: "pointer", fontSize: 12, color: COLORS.text, fontFamily: "'DM Sans', sans-serif" }}
                        onMouseEnter={(e) => e.currentTarget.style.background = COLORS.accentLight}
                        onMouseLeave={(e) => e.currentTarget.style.background = "none"}>{h.name}</button>
                    ))}
                  </div>
                )}
              </button>
            )}
            {/* New PDF — always visible */}
            <button onClick={() => { setPdf(null); setAnnotations([]); setActiveId(null); setPageTexts([]); setLoadError(null); setSelection(null); setZoom(1.0); if (pdf2) closePdf2(); }}
              title="Open a new PDF"
              style={{ fontSize: 12, padding: isCompact ? "5px 8px" : "5px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, cursor: "pointer", whiteSpace: "nowrap" }}>
              {isTiny ? "✕" : "New PDF"}
            </button>
          </div>
        </div>
        {/* PDF viewer area — flex row; PDF2 panel appears beside PDF1 when split */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* PDF 1 panel */}
          <div ref={viewerRef}
            onMouseDown={drawMode ? handleDrawStart : undefined}
            onMouseUp={drawMode ? undefined : handleViewerMouseUp}
            onClick={pdf2 ? () => setActivePanel(1) : undefined}
            style={{ flex: 1, overflow: "auto", padding: "24px", display: "flex", flexDirection: "column", alignItems: "center",
              boxShadow: pdf2 && activePanel === 1 ? `inset 0 0 0 2px ${COLORS.accent}` : "none",
              cursor: drawMode ? "crosshair" : "default",
              userSelect: drawMode ? "none" : "auto",
            }}>
            {layoutContainerWidth > 0 && pageNums.map((num) => (
              <PdfPage key={num} pdf={pdf} pageNum={num} containerWidth={layoutContainerWidth} zoom={zoom}
                annotations={annotations} drawMode={drawMode}
                onClickAnnotation={(id) => {
                  setActiveId(id); setActivePanel(1);
                  if (popOutActive) {
                    const ann = annotations.find((a) => a.id === id);
                    if (ann) bcRef.current?.postMessage({ type: "popout-select", annotation: ann, fileName });
                  } else {
                    setRightPanel("detail");
                  }
                }} />
            ))}
          </div>

          {/* PDF 2 panel (split view) */}
          {pdf2 && (
            <>
              <div style={{ width: 1, background: COLORS.border, flexShrink: 0 }} />
              <div ref={viewer2Ref} onClick={() => setActivePanel(2)}
                style={{ flex: 1, overflow: "auto", padding: "24px", display: "flex", flexDirection: "column", alignItems: "center",
                  boxShadow: activePanel === 2 ? `inset 0 0 0 2px ${COLORS.accent}` : "none" }}>
                <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 12, alignSelf: "center" }}>{fileName2}</div>
                {panel2Width > 0 && Array.from({ length: pdf2.numPages }, (_, i) => i + 1).map((num) => (
                  <PdfPage key={`p2-${num}`} pdf={pdf2} pageNum={num} containerWidth={panel2Width} zoom={zoom2}
                    annotations={annotations2}
                    onClickAnnotation={(id) => { setActiveId2(id); setActivePanel(2); setRightPanel("detail"); }} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ position: "relative", width: panelWidth, borderLeft: `1px solid ${COLORS.border}`, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        {/* Drag handle */}
        <div
          onMouseDown={startPanelDrag}
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 10, background: "transparent", transition: "background 0.15s" }}
          onMouseEnter={(e) => e.currentTarget.style.background = "rgba(200,132,46,0.25)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        />
        {popOutActive ? (
          /* P3: Pop-out active indicator — replaces Sidebar/DetailPanel */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, gap: 12, background: COLORS.panelBg }}>
            <div style={{ fontSize: 28 }}>📎</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, textAlign: "center" }}>Detail panel is open in a separate window</div>
            <div style={{ fontSize: 12, color: COLORS.textMuted, textAlign: "center", lineHeight: 1.5 }}>Click any highlight to view it in the pop-out window.</div>
            <button onClick={closePopOut}
              style={{ marginTop: 8, fontSize: 12, padding: "6px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, cursor: "pointer" }}>
              Close pop-out
            </button>
          </div>
        ) : rightPanel === "detail" && activeAnn ? (
          <>
            {/* Pop-out button (PDF1 only) */}
            {activePanel === 1 && (
              <div style={{ position: "absolute", top: 12, right: 56, zIndex: 20 }}>
                <button onClick={openPopOut} title="Open in pop-out window"
                  style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", cursor: "pointer", fontSize: 13, color: COLORS.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>↗</button>
              </div>
            )}
            {/* Read-only badge for PDF2 */}
            {activePanel === 2 && (
              <div style={{ padding: "6px 16px", fontSize: 11, color: COLORS.textMuted, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.sidebar }}>
                📄 {fileName2} · read-only
              </div>
            )}
            <DetailPanel annotation={activeAnn}
              onSend={activePanel === 1 ? (parentNodeId, msg) => sendMessage(activeId, parentNodeId, msg) : undefined}
              onBranchSelect={activePanel === 1 ? (nodeId, childIdx) => updateActiveBranch(activeId, nodeId, childIdx) : undefined}
              onSetFullActiveBranch={activePanel === 1 ? (newBranchAt) => setFullActiveBranch(activeId, newBranchAt) : undefined}
              onResolve={activePanel === 1 ? () => resolve(activeId) : undefined}
              onClose={() => { if (activePanel === 2) setActiveId2(null); else setActiveId(null); setRightPanel("sidebar"); }}
              onDelete={activePanel === 1 ? () => deleteAnn(activeId) : undefined}
              onNoteChange={activePanel === 1 ? (note) => updateNote(activeId, note) : undefined}
              loggedNodeIds={activePanel === 1 ? new Set(knowledgeLog.map((e) => e.nodeId)) : new Set()}
              onToggleLog={activePanel === 1 ? (nodeId, text) => toggleLogEntry(activeId, nodeId, text, activeAnn?.pageNum) : undefined} />
          </>
        ) : (
          <Sidebar annotations={annotations} activeId={activeId}
            onSelect={(id) => { setActiveId(id); setActivePanel(1); setRightPanel("detail"); const ann = annotations.find((a) => a.id === id); jumpToAnnotation(ann); }}
            onDelete={deleteAnn}
            knowledgeLog={knowledgeLog}
            onSelectLog={selectLogEntry}
            onRemoveLog={(id) => setKnowledgeLog((prev) => prev.filter((e) => e.id !== id))}
            annotations2={pdf2 ? annotations2 : undefined}
            activeId2={activeId2}
            fileName2={fileName2}
            onSelect2={(id) => { setActiveId2(id); setActivePanel(2); setRightPanel("detail"); }} />
        )}
      </div>

      {selection && (
        <SelectionToolbar rect={selection.toolbarRect} selectedColor={hlColor}
          onColorChange={setHlColor} onHighlight={doHighlight} onAskClaude={doAskClaude}
          onAddResearch={doAddResearchQ} />
      )}

      {/* Live drag rectangle while in draw mode */}
      {drawDragDisplay && (
        <div style={{
          position: "fixed", pointerEvents: "none", zIndex: 1002, borderRadius: 3,
          left: Math.min(drawDragDisplay.startX, drawDragDisplay.curX),
          top: Math.min(drawDragDisplay.startY, drawDragDisplay.curY),
          width: Math.abs(drawDragDisplay.curX - drawDragDisplay.startX),
          height: Math.abs(drawDragDisplay.curY - drawDragDisplay.startY),
          border: "2px dashed rgba(155,89,182,0.85)",
          background: "rgba(155,89,182,0.07)",
        }} />
      )}

      {popoverId && popoverRect && popoverAnn && (
        <Popover rect={popoverRect} annotation={popoverAnn}
          onExpand={() => { setActiveId(popoverId); setRightPanel("detail"); setPopoverId(null); setPopoverRect(null); }}
          onResolve={() => resolve(popoverId)} />
      )}
    </div>
  );
}
