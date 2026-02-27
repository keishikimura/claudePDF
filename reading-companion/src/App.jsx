import { useState, useEffect, useRef, useCallback } from "react";

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
    if (Math.abs((raw[i].top + raw[i].bottom) / 2 - (cur[0].top + cur[0].bottom) / 2) < 4) cur.push(raw[i]);
    else { lines.push(cur); cur = [raw[i]]; }
  }
  lines.push(cur);
  return lines.map((r) => {
    const l = Math.min(...r.map((x) => x.left)), t = Math.min(...r.map((x) => x.top));
    return { left: l, top: t, width: Math.max(...r.map((x) => x.right)) - l, height: Math.max(...r.map((x) => x.bottom)) - t };
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
    // Strip screenshots to save space; keep everything else
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

/* ── API via local proxy (no more sandbox issues!) ── */
const callClaude = async (systemPrompt, messages) => {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
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
  const MAX = 30000; // more room without sandbox constraints
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
function HighlightOverlay({ annotations, pageNum, onClickAnnotation }) {
  const anns = annotations.filter((a) => a.pageNum === pageNum && a.mergedRects?.length > 0);
  if (!anns.length) return null;
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}>
      {anns.map((ann) => {
        const c = ann.type === "claude" && ann.status === "resolved"
          ? { bg: "rgba(107,158,120,0.22)", hover: "rgba(107,158,120,0.38)" }
          : getHlColor(ann.color);
        return ann.mergedRects.map((r, i) => (
          <div key={`${ann.id}-${i}`}
            onClick={(e) => { e.stopPropagation(); onClickAnnotation(ann.id); }}
            style={{ position: "absolute", left: r.left, top: r.top, width: r.width, height: r.height, backgroundColor: c.bg, cursor: "pointer", pointerEvents: "auto", borderRadius: 3, transition: "background-color 0.15s" }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = c.hover}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = c.bg}
          />
        ));
      })}
    </div>
  );
}

/* ── PDF Page ── */
function PdfPage({ pdf, pageNum, containerWidth, annotations, onSelect, onClickAnnotation }) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const [dims, setDims] = useState(null);
  const dprRef = useRef(window.devicePixelRatio || 1);

  useEffect(() => {
    if (!containerWidth || containerWidth <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const baseVp = page.getViewport({ scale: 1 });
        const cssScale = (containerWidth - 48) / baseVp.width;
        const dpr = window.devicePixelRatio || 1;
        dprRef.current = dpr;
        const vp = page.getViewport({ scale: cssScale * dpr });
        const cssVp = page.getViewport({ scale: cssScale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = cssVp.width + "px"; canvas.style.height = cssVp.height + "px";
        setDims({ w: cssVp.width, h: cssVp.height });
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
          span.style.cssText = `position:absolute;left:${tx[4]}px;top:${tx[5] - fs}px;font-size:${fs}px;font-family:sans-serif;transform-origin:0 100%;transform:scaleX(${scaleX}) rotate(${Math.atan2(tx[1], tx[0])}rad);color:transparent;white-space:pre;cursor:text;line-height:1;`;
          tl.appendChild(span);
        });
      } catch (e) { console.error(`Page ${pageNum}:`, e); }
    })();
    return () => { cancelled = true; };
  }, [pdf, pageNum, containerWidth]);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;
    const range = sel.getRangeAt(0);
    const wrapper = wrapperRef.current, canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    const wr = wrapper.getBoundingClientRect();
    const merged = mergeRects(range.getClientRects(), wr);
    if (!merged.length) return;
    const screenshot = captureRegion(canvas, merged, dprRef.current);
    onSelect({ text, mergedRects: merged, screenshot, toolbarRect: range.getBoundingClientRect(), pageNum });
  }, [onSelect, pageNum]);

  return (
    <div ref={wrapperRef} onMouseUp={handleMouseUp}
      style={{ position: "relative", marginBottom: 16, boxShadow: "0 2px 12px rgba(44,36,23,0.08)", borderRadius: 4, overflow: "hidden", width: dims?.w || "100%", height: dims?.h || 400, background: "#fff", flexShrink: 0 }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div ref={textLayerRef} style={{ position: "absolute", top: 0, left: 0, overflow: "hidden", opacity: 0.3, lineHeight: 1, zIndex: 1 }} />
      <HighlightOverlay annotations={annotations} pageNum={pageNum} onClickAnnotation={onClickAnnotation} />
      <div style={{ position: "absolute", top: 8, right: 12, fontSize: 11, color: COLORS.textMuted, background: "rgba(255,253,249,0.85)", padding: "2px 8px", borderRadius: 4, zIndex: 3 }}>{pageNum}</div>
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
          : hasResp ? <div style={{ fontSize: 14, lineHeight: 1.7, color: isErr ? "#991B1B" : COLORS.text, whiteSpace: "pre-wrap", background: isErr ? "#FEE2E2" : "none", padding: isErr ? "8px 10px" : 0, borderRadius: isErr ? 6 : 0 }}>{lastA?.content}</div>
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
  const endRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [annotation?.messages?.length]);
  useEffect(() => { inputRef.current?.focus(); }, [annotation?.id]);
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
          <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
            {visibleMsgs.map((msg, i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: msg.role === "user" ? COLORS.accent : COLORS.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {msg.role === "user" ? "You" : "Claude"}
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: msg.isError ? "#991B1B" : COLORS.text, background: msg.isError ? "#FEE2E2" : "none", padding: msg.isError ? "8px 10px" : 0, borderRadius: msg.isError ? 6 : 0 }}>{msg.content}</div>
              </div>
            ))}
            {annotation.loading && <div style={{ fontSize: 14, color: COLORS.textMuted }}><span className="loading-dots">Thinking</span></div>}
            <div ref={endRef} />
          </div>
          <div style={{ padding: "12px 20px", borderTop: `1px solid ${COLORS.border}`, background: COLORS.sidebar }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
                placeholder="Ask a follow-up…"
                style={{ flex: 1, padding: "10px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.paper, fontSize: 14, color: COLORS.text, outline: "none" }} />
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
      ? (ann.messages.find((m) => m.role === "assistant")?.content?.slice(0, 90) || (ann.loading ? "Thinking…" : ""))
      : (ann.note || "No note");
    return (
      <div style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${COLORS.border}` }}>
        <button onClick={() => onSelect(ann.id)} style={{
          flex: 1, textAlign: "left", padding: "12px 16px",
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
function UploadScreen({ onUpload, loading, error }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const handle = (file) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) { alert("Please upload a PDF."); return; }
    const reader = new FileReader();
    reader.onload = (e) => onUpload(e.target.result, file.name);
    reader.readAsArrayBuffer(file);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: COLORS.bg, fontFamily: "'Source Serif 4', Georgia, serif" }}>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>📖</div>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: COLORS.text, marginBottom: 8, letterSpacing: "-0.02em" }}>Reading Companion</h1>
        <p style={{ fontSize: 16, color: COLORS.textMuted, marginBottom: 40, lineHeight: 1.6 }}>Upload a paper or textbook chapter. Highlight or ask Claude about anything confusing.</p>
        {error && <div style={{ marginBottom: 16, padding: "12px 16px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 14 }}>{error}</div>}
        {loading ? <div style={{ padding: 32, color: COLORS.textMuted }}><span className="loading-dots">Loading PDF</span></div>
        : (
          <div onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handle(e.dataTransfer.files[0]); }}
            style={{ padding: "48px 32px", borderRadius: 16, border: `2px dashed ${dragOver ? COLORS.accent : COLORS.border}`, background: dragOver ? COLORS.accentLight : COLORS.paper, cursor: "pointer" }}>
            <div style={{ fontSize: 18, color: COLORS.text, fontWeight: 600, marginBottom: 8 }}>Drop a PDF here</div>
            <div style={{ fontSize: 14, color: COLORS.textMuted }}>or click to browse</div>
            <input ref={inputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={(e) => handle(e.target.files?.[0])} />
          </div>
        )}
      </div>
    </div>
  );
}

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
  const viewerRef = useRef(null);
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;

  const activeAnn = annotations.find((a) => a.id === activeId);
  const popoverAnn = annotations.find((a) => a.id === popoverId);

  // Persist annotations
  useEffect(() => {
    if (fileNameRef.current && pdf) saveAnnotations(fileNameRef.current, annotations);
  }, [annotations, pdf]);

  useEffect(() => {
    if (!viewerRef.current) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setContainerWidth(e.contentRect.width); });
    ro.observe(viewerRef.current);
    return () => ro.disconnect();
  }, [pdf]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (!selection) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "h" || e.key === "H") { e.preventDefault(); doHighlight(); }
      if (e.key === "c" || e.key === "C") { e.preventDefault(); doAskClaude(); }
      if (e.key === "Escape") { setSelection(null); window.getSelection()?.removeAllRanges(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const handleUpload = async (arrayBuffer, name) => {
    setLoading(true); setLoadError(null);
    try {
      const lib = await loadPdfJs();
      const pdfDoc = await lib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      const texts = [];
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const content = await page.getTextContent();
        texts.push(content.items.map((it) => it.str).join(" "));
      }
      setPdf(pdfDoc); setPageTexts(texts); setFileName(name);
      const saved = loadAnnotationsFromStorage(name);
      setAnnotations(saved.map((a) => ({ ...a, loading: false })));
    } catch (e) { setLoadError(`Failed to load "${name}": ${e.message}.`); }
    setLoading(false);
  };

  const onSelectText = useCallback((sel) => {
    setSelection(sel);
    window.getSelection()?.removeAllRanges();
  }, []);

  const doHighlight = useCallback(() => {
    if (!selection) return;
    setAnnotations((prev) => [...prev, {
      id: `ann-${Date.now()}`, pageNum: selection.pageNum, rawText: selection.text,
      mergedRects: selection.mergedRects, screenshot: selection.screenshot,
      type: "highlight", color: hlColor, note: "", messages: [], status: "active", loading: false,
    }]);
    setSelection(null);
  }, [selection, hlColor]);

  const doAskClaude = useCallback(() => {
    if (!selection) return;
    const id = `ann-${Date.now()}`;
    const content = [];
    if (selection.screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: selection.screenshot } });
    content.push({ type: "text", text: `The user highlighted a passage on page ${selection.pageNum}. Above is the screenshot. Raw extracted text: "${selection.text}"\n\nIdentify the passage and explain it clearly in 2-4 sentences.` });
    const userMsg = { role: "user", content };
    setAnnotations((prev) => [...prev, {
      id, pageNum: selection.pageNum, rawText: selection.text,
      mergedRects: selection.mergedRects, screenshot: selection.screenshot,
      type: "claude", color: hlColor, note: "", messages: [userMsg], status: "active", loading: true,
    }]);
    setPopoverId(id); setPopoverRect(selection.toolbarRect); setSelection(null);

    const sys = buildSystemPrompt(pageTexts, annotations, selection.pageNum);
    callClaude(sys, [userMsg]).then((resp) => {
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
    callClaude(sys, newMsgs.filter((m) => !m.isError).map((m) => ({ role: m.role, content: m.content }))).then((resp) => {
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
      if (selection && !e.target.closest("[data-toolbar]")) setSelection(null);
      if (popoverId && !e.target.closest("[data-popover]")) { setPopoverId(null); setPopoverRect(null); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [selection, popoverId]);

  if (!pdf) return <UploadScreen onUpload={handleUpload} loading={loading} error={loadError} />;

  const pageNums = Array.from({ length: pdf.numPages }, (_, i) => i + 1);

  return (
    <div style={{ display: "flex", height: "100vh", background: COLORS.bg, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: "10px 24px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.paper, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 20 }}>📖</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>{fileName}</div>
              <div style={{ fontSize: 12, color: COLORS.textMuted }}>{pdf.numPages} pages · {annotations.length} annotations</div>
            </div>
          </div>
          <button onClick={() => { setPdf(null); setAnnotations([]); setActiveId(null); setPageTexts([]); setLoadError(null); setSelection(null); }}
            style={{ fontSize: 13, padding: "6px 14px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "none", color: COLORS.textMuted, cursor: "pointer" }}>
            New PDF
          </button>
        </div>
        <div ref={viewerRef} style={{ flex: 1, overflow: "auto", padding: "24px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          {containerWidth > 0 && pageNums.map((num) => (
            <PdfPage key={num} pdf={pdf} pageNum={num} containerWidth={containerWidth}
              annotations={annotations} onSelect={onSelectText}
              onClickAnnotation={(id) => { setActiveId(id); setRightPanel("detail"); }} />
          ))}
        </div>
      </div>

      <div style={{ width: 400, borderLeft: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
        {rightPanel === "detail" && activeAnn ? (
          <DetailPanel annotation={activeAnn}
            onSend={(msg) => askFollowUp(activeId, msg)}
            onResolve={() => resolve(activeId)}
            onClose={() => { setActiveId(null); setRightPanel("sidebar"); }}
            onDelete={() => deleteAnn(activeId)}
            onNoteChange={(note) => updateNote(activeId, note)} />
        ) : (
          <Sidebar annotations={annotations} activeId={activeId}
            onSelect={(id) => { setActiveId(id); setRightPanel("detail"); }}
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
