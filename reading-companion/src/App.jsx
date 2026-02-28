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
    // 1px vertical padding ensures full character descenders are covered
    return { left: l, top: t - 1, width: Math.max(...r.map((x) => x.right)) - l, height: Math.max(...r.map((x) => x.bottom)) - t + 2 };
  });
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

/* ── Storage via localStorage ── */
const storageKey = (name) => `rc:${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

function saveAnnotations(fileName, annotations) {
  try {
    const data = annotations.map(({ screenshot, loading, ...rest }) => rest);
    localStorage.setItem(storageKey(fileName), JSON.stringify(data));
  } catch (e) { console.warn("Save failed:", e); }
}

function loadAnnotationsFromStorage(fileName) {
  try {
    const raw = localStorage.getItem(storageKey(fileName));
    if (raw) return JSON.parse(raw);
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

const buildSystemPrompt = (pageTexts, annotations, focusPage) => {
  const MAX = 30000;
  const order = [];
  if (focusPage) { order.push(focusPage - 1); if (focusPage >= 2) order.push(focusPage - 2); if (focusPage < pageTexts.length) order.push(focusPage); }
  for (let i = 0; i < pageTexts.length; i++) if (!order.includes(i)) order.push(i);
  let doc = "", chars = 0; const inc = new Set();
  for (const idx of order) { const e = `\n[Page ${idx + 1}]\n${pageTexts[idx] || ""}\n`; if (chars + e.length > MAX && inc.size > 0) break; doc += e; chars += e.length; inc.add(idx); }
  const trunc = inc.size < pageTexts.length ? `\n[${pageTexts.length} pages, ${inc.size} shown.]` : "";
  const qa = annotations.filter((a) => a.type === "claude" && a.messages.length > 1).slice(-5)
    .map((a) => `Q (p.${a.pageNum}): "${a.rawText?.slice(0, 80)}"\nA: ${a.messages[1]?.content?.slice(0, 200) || ""}`).join("\n\n");
  return `You are a reading companion. The user highlights confusing passages. You receive a screenshot + raw extracted text (may be garbled for math). Use the screenshot as primary source. Be concise (2-4 sentences) initially, thorough in follow-ups.

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
function SelectionToolbar({ rect, selectedColor, onColorChange, onHighlight, onAskClaude }) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    const l = Math.max(8, Math.min(rect.left + rect.width / 2 - 110, window.innerWidth - 240));
    const above = rect.top - 52;
    setPos({ top: above > 8 ? above : rect.bottom + 8, left: l });
  }, [rect]);

  return (
    <div data-toolbar style={{
      position: "fixed", top: pos.top, left: pos.left, zIndex: 1001,
      display: "flex", alignItems: "center", gap: 4, padding: "6px 10px",
      background: "#fff", borderRadius: 10,
      boxShadow: "0 4px 20px rgba(44,36,23,0.16), 0 1px 4px rgba(44,36,23,0.08)",
      border: `1px solid ${COLORS.border}`, animation: "popIn 0.15s ease-out",
    }}>
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
        const c = ann.type === "claude" && ann.status === "resolved"
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
function PdfPage({ pdf, pageNum, containerWidth, zoom, annotations, onClickAnnotation }) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const [dims, setDims] = useState(null);
  // renderDims is only updated AFTER Phase 3 finishes painting the canvas.
  // Highlights use renderDims so they never jump ahead of the canvas render.
  const [renderDims, setRenderDims] = useState(null);
  const [shouldRender, setShouldRender] = useState(false);
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
        if (!cancelled) setRenderDims({ w: cssVp.width, h: cssVp.height });
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
  const hasResp = annotation?.messages?.length > 1;
  const loading = annotation?.loading;
  const isErr = annotation?.messages?.[annotation.messages.length - 1]?.isError;
  const lastA = [...(annotation?.messages || [])].reverse().find((m) => m.role === "assistant");
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

/* ── Detail Panel ── */
function DetailPanel({ annotation, onSend, onResolve, onClose, onDelete, onNoteChange }) {
  const [input, setInput] = useState("");
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  // Scroll the chat container (not the whole page) to bottom when messages arrive
  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [annotation?.messages?.length]);
  useEffect(() => { inputRef.current?.focus(); }, [annotation?.id]);
  // Auto-expand textarea as content grows
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);
  const send = () => { if (!input.trim()) return; onSend(input.trim()); setInput(""); };
  if (!annotation) return null;

  const isClaude = annotation.type === "claude";
  const visibleMsgs = isClaude ? annotation.messages.filter((_, i) => i > 0) : [];
  const hlColor = getHlColor(annotation.color);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: COLORS.panelBg }}>
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: hlColor.dot, flexShrink: 0 }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.accent, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {isClaude ? "Thread" : "Note"} · Page {annotation.pageNum}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {isClaude && annotation.status !== "resolved" && (
            <button onClick={onResolve} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: `1px solid ${COLORS.resolve}`, background: "none", color: COLORS.resolve, cursor: "pointer", fontWeight: 600 }}>✓</button>
          )}
          <button onClick={onDelete} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #E5A0A0", background: "none", color: "#C53030", cursor: "pointer", fontWeight: 600 }}>✕</button>
          <button onClick={onClose} style={{ fontSize: 16, background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: "0 4px" }}>←</button>
        </div>
      </div>
      {annotation.screenshot && (
        <div style={{ padding: "12px 20px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.accentLight }}>
          <img src={`data:image/png;base64,${annotation.screenshot}`} style={{ maxWidth: "100%", maxHeight: 100, borderRadius: 4 }} alt="" />
        </div>
      )}
      {isClaude ? (
        <>
          <div ref={chatRef} style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
            {visibleMsgs.map((msg, i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: msg.role === "user" ? COLORS.accent : COLORS.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {msg.role === "user" ? "You" : "Claude"}
                </div>
                {msg.role === "assistant" && !msg.isError
                  ? <div style={{ fontSize: 14, color: COLORS.text }}><Markdown text={msg.content} /></div>
                  : <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: msg.isError ? "#991B1B" : COLORS.text, background: msg.isError ? "#FEE2E2" : "none", padding: msg.isError ? "8px 10px" : 0, borderRadius: msg.isError ? 6 : 0 }}>{msg.content}</div>}
              </div>
            ))}
            {annotation.loading && <div style={{ fontSize: 14, color: COLORS.textMuted }}><span className="loading-dots">Thinking</span></div>}
          </div>
          <div style={{ padding: "12px 20px", borderTop: `1px solid ${COLORS.border}`, background: COLORS.sidebar }}>
            <div style={{ display: "flex", gap: 8 }}>
              <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask a follow-up… (Shift+Enter for new line)"
                rows={1}
                style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 14, color: COLORS.text, outline: "none", resize: "none", overflow: "hidden", lineHeight: 1.5, fontFamily: "'DM Sans', sans-serif", minHeight: 42, maxHeight: 160 }} />
              <button onClick={send} disabled={!input.trim()}
                style={{ padding: "10px 16px", borderRadius: 8, background: input.trim() ? COLORS.accent : COLORS.border, color: "#fff", border: "none", cursor: input.trim() ? "pointer" : "default", fontWeight: 600 }}>↑</button>
            </div>
          </div>
        </>
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
function Sidebar({ annotations, activeId, onSelect, onDelete }) {
  const highlights = annotations.filter((a) => a.type === "highlight");
  const activeClaudes = annotations.filter((a) => a.type === "claude" && a.status === "active");
  const resolvedClaudes = annotations.filter((a) => a.type === "claude" && a.status === "resolved");

  const Item = ({ ann }) => {
    const c = getHlColor(ann.color);
    const preview = ann.type === "claude"
      ? (ann.messages.find((m) => m.role === "assistant")?.content || (ann.loading ? "Thinking…" : ""))
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
              Page {ann.pageNum} · {ann.type === "claude" ? (ann.messages.filter(m => m.role === "user").length > 1 ? `${ann.messages.filter(m => m.role === "user").length - 1} follow-ups` : "Quick answer") : "Highlight"}
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.accent, letterSpacing: "0.04em", textTransform: "uppercase" }}>Annotations ({annotations.length})</div>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {annotations.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: COLORS.textMuted, fontSize: 14, lineHeight: 1.6 }}>
            Select text, then press <b>H</b> to highlight or <b>C</b> to ask Claude
          </div>
        )}
        <Section title="Highlights" items={highlights} />
        <Section title="Questions" items={activeClaudes} />
        <Section title="Resolved" items={resolvedClaudes} />
      </div>
    </div>
  );
}

/* ── Upload ── */
function UploadScreen({ onUpload, loading, error, history, onRemoveHistory }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  // When re-opening a history item we show its name so the user knows which file to pick
  const [hintName, setHintName] = useState(null);

  const readFile = (file) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) { alert("Please upload a PDF."); return; }
    setHintName(null);
    const reader = new FileReader();
    reader.onload = (e) => onUpload(e.target.result, file.name);
    reader.readAsArrayBuffer(file);
  };

  // Try IDB cache first (no picker needed); fall back to a file picker if not cached yet.
  const openHistory = async (name) => {
    const buffer = await loadPdfIDB(name);
    if (buffer) { onUpload(buffer, name); return; }
    // Not cached — ask the user to re-select the file
    setHintName(name);
    inputRef.current?.click();
  };

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

        {history.length > 0 && (
          <div style={{ marginTop: 32 }}>
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
  const [history, setHistory] = useState(() => loadHistory());
  const [panelWidth, setPanelWidth] = useState(400);
  const [showThumbs, setShowThumbs] = useState(true);
  const [thumbsWidth, setThumbsWidth] = useState(120);
  const [currentPage, setCurrentPage] = useState(1);
  const panelDragRef = useRef(null);
  const thumbsDragRef = useRef(null);
  const isDraggingPanelRef = useRef(false);
  const viewerRef = useRef(null);
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;
  const pendingScrollRef = useRef(null);       // zoom scroll correction
  const pendingResizeScrollRef = useRef(null); // resize/strip-toggle scroll anchor
  const containerWidthRef = useRef(0);         // previous containerWidth (sync, for ResizeObserver)
  const currentPageRef = useRef(1);            // sync mirror of currentPage state
  currentPageRef.current = currentPage;

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
    thumbsDragRef.current = { startX: e.clientX, startWidth: thumbsWidth };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    if (viewerRef.current) viewerRef.current.style.pointerEvents = "none";
    const move = (ev) => {
      const delta = ev.clientX - thumbsDragRef.current.startX;
      setThumbsWidth(Math.max(80, Math.min(240, thumbsDragRef.current.startWidth + delta)));
    };
    const up = () => {
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

  const activeAnn = annotations.find((a) => a.id === activeId);
  const popoverAnn = annotations.find((a) => a.id === popoverId);

  // Persist annotations + keep history annotation count in sync
  useEffect(() => {
    if (!fileNameRef.current || !pdf) return;
    saveAnnotations(fileNameRef.current, annotations);
    setHistory(upsertHistory(fileNameRef.current, annotations.length));
  }, [annotations, pdf]);

  useEffect(() => {
    if (!viewerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      if (isDraggingPanelRef.current) return; // don't re-layout pages while resizing panel
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

  // Restore scroll anchor after page dims settle (Phase 1 is async, 80ms is enough for cached pages).
  // The cleanup cancels the timeout on each rapid containerWidth change, so we only restore
  // 80ms after the *last* resize event. The anchor is nulled inside the timeout (not before)
  // so intermediate resize callbacks don't overwrite it with a drifted position.
  useEffect(() => {
    if (!pendingResizeScrollRef.current) return;
    const { pageNum, fraction } = pendingResizeScrollRef.current;
    const t = setTimeout(() => {
      pendingResizeScrollRef.current = null; // clear only after restoring, not before
      if (!viewerRef.current) return;
      const el = viewerRef.current.querySelector(`[data-page="${pageNum}"]`);
      if (el) viewerRef.current.scrollTop = el.offsetTop + fraction * el.offsetHeight;
    }, 80);
    return () => clearTimeout(t);
  }, [containerWidth]);

  // Track which page is most visible in the viewer (drives thumbnail strip highlight + scroll)
  useEffect(() => {
    if (!pdf || !viewerRef.current || containerWidth <= 0) return;
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
  }, [pdf, containerWidth]);

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
      const saved = loadAnnotationsFromStorage(name);
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
    content.push({ type: "text", text: `The user highlighted a passage on page ${selection.pageNum}. Above is the screenshot. Raw extracted text: "${selection.text}"\n\nIdentify the passage and explain it clearly in 2-4 sentences.` });
    const userMsg = { role: "user", content };
    setAnnotations((prev) => [...prev, {
      id, pageNum: selection.pageNum, rawText: selection.text,
      mergedRects: selection.mergedRects, normalized: selection.normalized, screenshot: selection.screenshot,
      type: "claude", color: hlColor, note: "", messages: [userMsg], status: "active", loading: true,
    }]);
    setPopoverId(id); setPopoverRect(selection.toolbarRect); setSelection(null);

    const sys = buildSystemPrompt(pageTexts, annotations, selection.pageNum);
    callClaude(sys, [userMsg], model).then((resp) => {
      setAnnotations((prev) => prev.map((a) => a.id === id ? { ...a, loading: false, messages: [...a.messages, { role: "assistant", content: resp }] } : a));
    }).catch((err) => {
      setAnnotations((prev) => prev.map((a) => a.id === id ? { ...a, loading: false, messages: [...a.messages, { role: "assistant", content: `Error: ${err.message}`, isError: true }] } : a));
    });
  }, [selection, hlColor, pageTexts, annotations]);

  const askFollowUp = useCallback((annId, msg) => {
    const ann = annotations.find((a) => a.id === annId);
    if (!ann) return;
    const newMsgs = [...ann.messages, { role: "user", content: msg }];
    setAnnotations((prev) => prev.map((a) => a.id === annId ? { ...a, loading: true, messages: newMsgs } : a));
    const sys = buildSystemPrompt(pageTexts, annotations.filter((a) => a.id !== annId), ann.pageNum);
    callClaude(sys, newMsgs.filter((m) => !m.isError).map((m) => ({ role: m.role, content: m.content })), model).then((resp) => {
      setAnnotations((prev) => prev.map((a) => a.id === annId ? { ...a, loading: false, messages: [...a.messages, { role: "assistant", content: resp }] } : a));
    }).catch((err) => {
      setAnnotations((prev) => prev.map((a) => a.id === annId ? { ...a, loading: false, messages: [...a.messages, { role: "assistant", content: `Error: ${err.message}`, isError: true }] } : a));
    });
  }, [pageTexts, annotations]);

  const resolve = (id) => {
    setAnnotations((prev) => prev.map((a) => a.id === id ? { ...a, status: "resolved" } : a));
    setPopoverId(null); setPopoverRect(null);
    if (activeId === id) { setActiveId(null); setRightPanel("sidebar"); }
  };

  const deleteAnn = (id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    if (popoverId === id) { setPopoverId(null); setPopoverRect(null); }
    if (activeId === id) { setActiveId(null); setRightPanel("sidebar"); }
  };

  const updateNote = (id, note) => {
    setAnnotations((prev) => prev.map((a) => a.id === id ? { ...a, note } : a));
  };

  useEffect(() => {
    const h = (e) => {
      if (selection && !e.target.closest("[data-toolbar]")) { window.getSelection()?.removeAllRanges(); setSelection(null); }
      if (popoverId && !e.target.closest("[data-popover]")) { setPopoverId(null); setPopoverRect(null); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [selection, popoverId]);

  if (!pdf) return (
    <UploadScreen onUpload={handleUpload} loading={loading} error={loadError}
      history={history}
      onRemoveHistory={(name) => setHistory(removeFromHistory(name))} />
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
            {/* Zoom controls — always visible */}
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button onClick={() => handleZoom(Math.max(MIN_ZOOM, parseFloat((zoom - ZOOM_STEP).toFixed(2))))} title="Zoom out (⌘-)"
                style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", cursor: "pointer", fontSize: 16, color: COLORS.text, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
              <span style={{ fontSize: 12, minWidth: 38, textAlign: "center", color: COLORS.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => handleZoom(Math.min(MAX_ZOOM, parseFloat((zoom + ZOOM_STEP).toFixed(2))))} title="Zoom in (⌘=)"
                style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${COLORS.border}`, background: "none", cursor: "pointer", fontSize: 16, color: COLORS.text, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            </div>
            {/* New PDF — always visible */}
            <button onClick={() => { setPdf(null); setAnnotations([]); setActiveId(null); setPageTexts([]); setLoadError(null); setSelection(null); setZoom(1.0); }}
              title="Open a new PDF"
              style={{ fontSize: 12, padding: isCompact ? "5px 8px" : "5px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, cursor: "pointer", whiteSpace: "nowrap" }}>
              {isTiny ? "✕" : "New PDF"}
            </button>
          </div>
        </div>
        <div ref={viewerRef} onMouseUp={handleViewerMouseUp} style={{ flex: 1, overflow: "auto", padding: "24px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          {containerWidth > 0 && pageNums.map((num) => (
            <PdfPage key={num} pdf={pdf} pageNum={num} containerWidth={containerWidth} zoom={zoom}
              annotations={annotations}
              onClickAnnotation={(id) => { setActiveId(id); setRightPanel("detail"); }} />
          ))}
        </div>
      </div>

      <div style={{ position: "relative", width: panelWidth, borderLeft: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
        {/* Drag handle */}
        <div
          onMouseDown={startPanelDrag}
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 10, background: "transparent", transition: "background 0.15s" }}
          onMouseEnter={(e) => e.currentTarget.style.background = "rgba(200,132,46,0.25)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        />
        {rightPanel === "detail" && activeAnn ? (
          <DetailPanel annotation={activeAnn}
            onSend={(msg) => askFollowUp(activeId, msg)}
            onResolve={() => resolve(activeId)}
            onClose={() => { setActiveId(null); setRightPanel("sidebar"); }}
            onDelete={() => deleteAnn(activeId)}
            onNoteChange={(note) => updateNote(activeId, note)} />
        ) : (
          <Sidebar annotations={annotations} activeId={activeId}
            onSelect={(id) => { setActiveId(id); setRightPanel("detail"); const ann = annotations.find((a) => a.id === id); jumpToAnnotation(ann); }}
            onDelete={deleteAnn} />
        )}
      </div>

      {selection && (
        <SelectionToolbar rect={selection.toolbarRect} selectedColor={hlColor}
          onColorChange={setHlColor} onHighlight={doHighlight} onAskClaude={doAskClaude} />
      )}

      {popoverId && popoverRect && popoverAnn && (
        <Popover rect={popoverRect} annotation={popoverAnn}
          onExpand={() => { setActiveId(popoverId); setRightPanel("detail"); setPopoverId(null); setPopoverRect(null); }}
          onResolve={() => resolve(popoverId)} />
      )}
    </div>
  );
}
