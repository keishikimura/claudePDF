# Reading Companion — Project Roadmap

This file is our living agenda. Short-term fixes and long-term visions run in parallel.
Update this file as we work through items.

---

## Agent Assignment Guide

| Task type | Agent | Rationale |
|---|---|---|
| UI tweaks, styling, simple bugs | **Haiku** | Fast, cheap, low reasoning demand |
| Core logic, PDF rendering, API integration, review | **Sonnet** | Balanced — workhorse for most sessions |
| System design, prompt architecture, complex features | **Opus** | Heavyweight reasoning for architecture decisions |

> **Workflow suggestion**: Use Haiku to draft boilerplate or styling, Sonnet to validate
> and integrate, Opus for the rare deep-design sessions (e.g. the adaptive reading system).

---

## Sprint 1 — Stability & Basic UX (current)

| # | Item | Status | Agent |
|---|---|---|---|
| 1 | Large PDFs crash (white screen) | ✅ Done | Sonnet |
| 2 | Zoom in / out controls | ✅ Done | Sonnet |
| 3 | Highlights ugly / miss full lines | ✅ Done | Sonnet |
| 4 | PDF loads immediately; text extracted in background | ✅ Done | Sonnet |
| 5 | Highlight flip (text layer y-position off by 0.15×fs) | ✅ Done | Sonnet |
| 6 | Cross-page highlighting (viewer-level mouseup) | ✅ Done | Sonnet |
| 7 | Markdown rendering in chat (custom renderer) | ✅ Done | Sonnet |
| 8 | Auto-expanding textarea for follow-up input | ✅ Done | Sonnet |
| 9 | Model selector (Haiku / Sonnet / Opus) | ✅ Done | Sonnet |
| 10 | File history on upload screen with re-open | ✅ Done | Sonnet |

---

## Sprint 2 — Reading UX

| # | Item | Status | Agent |
|---|---|---|---|
| 5 | Click annotation in sidebar → scroll to page | ✅ Done | Sonnet |
| 6 | Page thumbnail strip (lazy-rendered, resizable, closable) | ✅ Done | Sonnet |
| 7 | Export annotations as Markdown or JSON | ✅ Done | Sonnet |
| 8 | Math/equation rendering in highlights (KaTeX or MathJax) | ✅ Done | Sonnet |
| 9 | Drag-to-resize the sidebar panel | ✅ Done | Haiku |
| 10 | Pinch-to-zoom on trackpad (wheel event) | ✅ Done | Haiku |
| 11 | Page jump input (type page number, prev/next arrows) | ✅ Done | Sonnet |

---

## Sprint 3 — Conversation UX

### Branching chat threads

Goal: let the user reply to any Claude message in an annotation thread and
open a new branch, without abandoning the other lines of inquiry. Each branch
is a separate linear context passed to Claude (root → current leaf).

UI: **user-selectable** between two modes:
- **Tab mode** (default): branch tabs appear beneath any message that has
  multiple children. Compact, keeps the panel narrow.
- **Tree mode** (opt-in): indented nested replies, Reddit-style. Better for
  seeing the full shape of the conversation at a glance.

Data model: annotation `messages` becomes a tree of nodes
`{ id, role, content, children: [] }` rooted at the initial user message.
Branching creates a new child; navigating switches the active path.

| # | Item | Status | Agent |
|---|---|---|---|
| B1 | Tree data model for annotation messages | ✅ Done | Sonnet |
| B2 | Tab UI — branch tabs at split points, linear view within each branch | ✅ Done | Sonnet |
| B3 | Tree UI — indented nested replies (opt-in preference) | ✅ Done | Sonnet |
| B4 | Claude context = path from root to current leaf (no branch leakage) | ✅ Done | Sonnet |

### Pop-out detail panel

Goal: detach the annotation detail panel into a separate browser window so
the user gets more reading space and can position the chat freely. The two
windows stay in sync — clicking any highlight in the PDF updates the pop-out.

Implementation: `BroadcastChannel` API (same-origin, no server needed).
Main window emits `{ type: "select", annotation }` on highlight click; pop-out
listens and renders `DetailPanel`. Replies in the pop-out broadcast back;
main window applies the state update. Fully bi-directional.

| # | Item | Status | Agent |
|---|---|---|---|
| P1 | Pop-out window opens `DetailPanel` via `window.open` | ✅ Done | Sonnet |
| P2 | `BroadcastChannel` sync: selection → pop-out, replies → main | ✅ Done | Sonnet |
| P3 | Main window shows "Pop-out active" indicator; highlights still clickable | ✅ Done | Haiku |

---

## Sprint 5 — Academic Writing Mode (Refine-inspired)

Goal: tailor Claude's responses toward academic rigor — the way
[Refine](https://ben-golub.com) tunes responses for scholarly prose.

| # | Item | Status | Agent |
|---|---|---|---|
| A1 | System prompt mode toggle ("General" vs "Academic") | ✅ Done | Sonnet |
| A2 | Academic prompt: ask for claims, evidence, assumptions, gaps | ✅ Done | Sonnet |
| A3 | Academic prompt: flag logical leaps, undefined terms, hedging | ✅ Done | Sonnet |
| A4 | Citation-aware context: pass detected author/year spans to Claude | ✅ Done | Sonnet |
| A5 | "Explain like a grad student" vs "Explain like I'm new" presets | ✅ Done | Sonnet |

> **Note on training**: No fine-tuning needed. Prompt engineering alone can produce
> Refine-level behavior. Opus designs the prompts; Sonnet integrates them.

---

## Long Horizon — Reading Projects (Notion-like)

Vision: group PDFs into named learning projects (e.g. "ML Theory", "Macro Reading List").
Each project has a shared workspace — annotations from all its PDFs are visible together,
and a running "big-picture" tracker surfaces aggregate confusion and open questions.

| # | Item | Status | Agent |
|---|---|---|---|
| 22 | Project directory: named collections that group related PDFs | ✅ Done | Sonnet |
| 23 | Per-project confusion tracker: starred questions/gaps aggregated from all PDFs | ✅ Done | Sonnet |
| 24 | Project-level Claude: "across all papers I've read, what do I still not understand about X?" | ✅ Done | Sonnet |
| 25 | Project view: side-by-side PDFs, shared annotation search | ✅ Done | Sonnet |

---

## Long Horizon — Adaptive Knowledge System

Vision: as you read, insights are logged, indexed, and made searchable across sessions.
Claude queries only what it needs — general knowledge proceeds freely, specific context
triggers a targeted read of the document.

| # | Item | Status | Agent |
|---|---|---|---|
| 16 | Persistent annotation store (SQLite or file, not just localStorage) | ✅ Done | Sonnet |
| 17 | Per-session "knowledge log" — key concepts, definitions, open questions | ✅ Done | Sonnet |
| 18 | Cross-document search: "what did I read about X?" | ✅ Done | Sonnet |
| 19 | Adaptive context: detect if question is general vs paper-specific | ✅ Done | Sonnet |
| 20 | If paper-specific: pass only relevant pages (semantic chunking) | ✅ Done | Sonnet |
| 21 | Knowledge graph view: concepts linked across papers | ✅ Done | Sonnet |

> **Cost mitigation**: Use embeddings (e.g. via Voyage AI) to chunk and index PDF text.
> Only send chunks with high semantic similarity to the question — not full documents.
> Haiku handles simple lookups; Sonnet handles synthesis; Opus handles graph reasoning.

---

## Sprint 6 — Research Queue

Goal: capture forward-looking research questions while reading and consolidate them
into a thematic index on the home screen. Distinct from clarification questions (Claude
threads) — these are open-ended inquiries to pursue later, possibly across documents.

| # | Item | Status | Agent |
|---|---|---|---|
| R1 | `type: "research"` annotation; `R` button in SelectionToolbar with inline question input | ✅ Done | Sonnet |
| R2 | Sidebar "Research" tab — purple visual treatment, lists all research questions | ✅ Done | Sonnet |
| R3 | Home screen Research Queue: cross-document index via `/api/all-research` | ✅ Done | Sonnet |
| R4 | "Synthesize" button: Claude groups research questions into themes (markdown output) | ✅ Done | Sonnet |

---

## Parking Lot (ideas, not yet scoped)

- Multi-PDF workspace (tabbed interface)
- Collaborative annotations (shared session)
- Audio read-aloud with highlight sync
- Browser extension version
- ✅ Export to Anki flashcards from Q&A threads (tab-separated .txt; front=highlight, back=Claude's first response)

---

## How to use this file

- When we start a session, scan this file for context.
- Mark items ✅ Done / 🔄 In Progress / ⬜ Todo.
- Move completed sprints to an `## Archive` section at the bottom.
- Add new ideas to the Parking Lot; promote to a sprint when scoped.
