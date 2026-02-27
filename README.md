# 📖 Reading Companion

A PDF reader with AI-powered annotations. Highlight confusing passages and get instant explanations from Claude, or mark them with colored highlights and your own notes.

## Setup

### 1. Get your Anthropic API key

Go to [console.anthropic.com](https://console.anthropic.com/) and create an API key.

### 2. Install and configure

```bash
# Clone or download this project, then:
cd reading-companion
npm install

# Create your .env file
cp .env.example .env
# Edit .env and paste your API key:
# ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run

```bash
npm run dev
```

This starts both the Express API proxy (port 3001) and the Vite dev server (port 5173). Open **http://localhost:5173** in your browser.

## Usage

1. **Upload a PDF** — drag and drop or click to browse
2. **Select text** — a toolbar appears with color dots, **H** (highlight), and **C** (ask Claude)
3. **Press H** — creates a plain highlight you can annotate with notes
4. **Press C** — sends a screenshot + text to Claude for explanation
5. **Popover** — shows Claude's quick answer. Click "Got it" to resolve or "Dig deeper" for a threaded conversation
6. **Click any highlight** — reopens its note or conversation thread
7. **Annotations persist** — saved to localStorage, survives browser refresh

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `H` | Highlight selected text |
| `C` | Ask Claude about selected text |
| `Esc` | Dismiss selection |

## Production build

```bash
npm run build
npm start
```

Serves the built app from the Express server on port 3001.

## Architecture

- **Frontend**: React + Vite, pdf.js for rendering
- **Backend**: Express server proxying Anthropic API calls
- **Storage**: localStorage (annotations persist per PDF filename)
- **AI**: Claude Sonnet via screenshot (vision) + extracted text for context
