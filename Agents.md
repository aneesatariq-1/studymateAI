# StudyMate AI — Project Specification & Upgrade Brief

**Purpose of this document:** Ground-truth reference for an AI coding agent (Cursor / Antigravity) to safely extend this project. It contains the current working codebase, the new feature requirements, and hard constraints that must not be reverted. Read this entire file before making changes.

---

## 1. Project Overview

StudyMate AI is a RAG (Retrieval-Augmented Generation) study assistant. A student uploads a document, the backend chunks and embeds it, and the student can then chat with an AI tutor that answers strictly from that document's content — including generating summaries, MCQs, and short-answer practice questions.

**Current stack:**
- Backend: FastAPI (Python), Google Gemini API (`google-genai` SDK) for embeddings + chat, in-memory vector store (cosine similarity, no external vector DB)
- Frontend: Next.js 14 (App Router), TypeScript, Tailwind CSS 3, `react-markdown` for rendering AI responses

**Current limitation to fix:** only PDF upload is supported. This must be extended to also support **DOCX, XLSX, and PPTX**.

---

## 2. Hard Constraints — Do Not Regress These

The project has already been through several rounds of bug fixes. An agent must **not** reintroduce these:

| Area | Correct value | Known-wrong value that must NOT be used |
|---|---|---|
| Gemini embedding model | `gemini-embedding-001` | `models/embedding-001` (old SDK path, 404s) |
| Embedding response access | `response.embeddings[0].values` | `response.embedding.values` (attribute doesn't exist) |
| Gemini chat model | `gemini-3.6-flash` | `gemini-1.5-flash`, `gemini-2.5-flash` (both retired/closed to new keys) |
| CORS | `allow_origins=["*"]` with `allow_credentials=False` | `allow_credentials=True` combined with wildcard origin (browsers reject this) |
| `/api/chat` request body | JSON body via Pydantic model (`{"question": "..."}"`) | `Form(...)` (frontend sends JSON, not form-data — mismatch causes 422) |
| Next.js custom 404 file | `app/not-found.tsx` (exact name) | `app/notfound.tsx` (silently ignored by Next.js) |
| `app/globals.css` | Must contain the three `@tailwind` directives | Empty file (breaks all styling with no error) |
| `postcss.config.js` | Must exist at project root, using `tailwindcss: {}` / `autoprefixer: {}` plugin syntax (Tailwind v3 syntax) | Missing entirely, or Tailwind v4 installed with v3 config syntax |
| Tailwind/PostCSS/Autoprefixer versions | `tailwindcss@3.4.x`, not v4 | v4 (breaks the v3-style postcss config silently) |
| API keys | Never hard-code or print the `GEMINI_API_KEY` in logs, code comments, or committed files | — |

**Verification checklist an agent should run after any change:**
1. `npm ls tailwindcss postcss autoprefixer` → confirm all v3/v8/v10 respectively.
2. After any config change: fully stop dev server → delete `.next` → `npm run dev` (Next.js only reads `postcss.config.js` at startup, not on hot reload).
3. Backend: restart `uvicorn` after any change to `rag.py` or `main.py`.

---

## 3. Current File Structure

```
studymateAI/
├── backend/
│   ├── app/
│   │   ├── __init__.py          (empty)
│   │   ├── main.py              (FastAPI app, routes)
│   │   └── rag.py               (embedding/indexing/chat logic)
│   ├── uploads/                 (uploaded files land here)
│   ├── .env                     (GEMINI_API_KEY=...)
│   └── requirements.txt
└── frontend/
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx
    │   ├── not-found.tsx
    │   └── page.tsx
    ├── .env.local                (NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000)
    ├── package.json
    ├── postcss.config.js
    ├── tailwind.config.ts
    └── tsconfig.json
```

---

## 4. Current Working Backend Code (reference — extend, don't rewrite from scratch)

### `backend/requirements.txt`
```
fastapi
uvicorn
google-genai
pypdf
python-dotenv
python-multipart
```
**Add for this upgrade:** `python-docx`, `openpyxl`, `python-pptx`

### `backend/app/rag.py`
```python
import os
import math
from pypdf import PdfReader
from google import genai
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise ValueError("GEMINI_API_KEY is missing in the backend/.env file!")

client = genai.Client(api_key=api_key)

indexed_store = {
    "chunks": [],
    "embeddings": []
}

def cosine_similarity(v1, v2):
    dot_product = sum(a * b for a, b in zip(v1, v2))
    magnitude1 = math.sqrt(sum(a * a for a in v1))
    magnitude2 = math.sqrt(sum(b * b for b in v2))
    if not magnitude1 or not magnitude2:
        return 0.0
    return dot_product / (magnitude1 * magnitude2)

def process_pdf_and_index(file_path: str):
    reader = PdfReader(file_path)
    full_text = ""
    for page in reader.pages:
        text = page.extract_text()
        if text:
            full_text += text + "\n"

    if not full_text.strip():
        raise Exception("Could not extract any text from this PDF.")

    chunk_size = 800
    overlap = 100
    chunks = []
    for i in range(0, len(full_text), chunk_size - overlap):
        chunk = full_text[i:i + chunk_size]
        if chunk.strip():
            chunks.append(chunk)

    embeddings = []
    for chunk in chunks:
        response = client.models.embed_content(
            model="gemini-embedding-001",
            contents=chunk,
        )
        embeddings.append(response.embeddings[0].values)

    indexed_store["chunks"] = chunks
    indexed_store["embeddings"] = embeddings

    return len(chunks), len(reader.pages)

def answer_question_from_rag(question: str) -> str:
    if not indexed_store["chunks"]:
        raise Exception("Please upload and index a PDF first.")

    top_k = 6 if len(indexed_store["chunks"]) > 6 else len(indexed_store["chunks"])

    q_response = client.models.embed_content(
        model="gemini-embedding-001",
        contents=question,
    )
    q_embedding = q_response.embeddings[0].values

    similarities = []
    for idx, emb in enumerate(indexed_store["embeddings"]):
        score = cosine_similarity(q_embedding, emb)
        similarities.append((score, indexed_store["chunks"][idx]))

    similarities.sort(key=lambda x: x[0], reverse=True)
    top_chunks = [item[1] for item in similarities[:top_k]]
    context_text = "\n\n--- Next Chunk ---\n\n".join(top_chunks)

    prompt = f"""
You are StudyMate AI, a smart personalized academic tutor for students.
Answer the question based strictly on the provided document context below.

[DOCUMENT CONTEXT]:
{context_text}

[STUDENT QUESTION]:
{question}

[RESPONSE GUIDELINES]:
- Always respond in clear, professional English only.
- If asked for a summary, give a thorough summary of at least 8-10 bullet points.
- If asked for MCQs, generate exactly the number requested, each with 4 options,
  the correct answer clearly marked, and a one-line explanation.
- If asked for short-answer questions, generate exactly the number requested,
  each with a concise 1-3 sentence model answer.
- Use bullet points and numbered lists for structure.
- Bold important technical terms.
"""

    response = client.models.generate_content(
        model="gemini-3.6-flash",
        contents=prompt
    )
    return response.text
```

### `backend/app/main.py`
```python
import os
import shutil
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.rag import process_pdf_and_index, answer_question_from_rag

app = FastAPI(title="StudyMate AI - Python Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

class ChatRequest(BaseModel):
    question: str

@app.get("/")
def home():
    return {"status": "StudyMate AI Python Backend is Running!"}

@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        total_chunks, total_pages = process_pdf_and_index(file_path)
        return {
            "success": True,
            "message": "PDF successfully processed and indexed!",
            "filename": file.filename,
            "totalPages": total_pages,
            "totalChunks": total_chunks
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat")
async def chat_with_pdf(payload: ChatRequest):
    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    try:
        answer = answer_question_from_rag(payload.question)
        return {"success": True, "answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

---

## 5. New Feature Requirement: Multi-Format Document Upload

Extend upload support from PDF-only to: **`.pdf`, `.docx`, `.xlsx`/`.xls`, `.pptx`**.

### 5.1 Backend changes required

**`requirements.txt`** — add:
```
python-docx
openpyxl
python-pptx
```

**`rag.py`** — refactor into format-specific extractors that all feed the same chunk/embed pipeline:

```python
def extract_text_from_pdf(file_path: str) -> str:
    reader = PdfReader(file_path)
    text = ""
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text += page_text + "\n"
    return text

def extract_text_from_docx(file_path: str) -> str:
    from docx import Document
    doc = Document(file_path)
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts)

def extract_text_from_xlsx(file_path: str) -> str:
    from openpyxl import load_workbook
    wb = load_workbook(file_path, data_only=True)
    parts = []
    for sheet in wb.worksheets:
        parts.append(f"--- Sheet: {sheet.title} ---")
        for row in sheet.iter_rows(values_only=True):
            row_text = " | ".join(str(cell) for cell in row if cell is not None)
            if row_text.strip():
                parts.append(row_text)
    return "\n".join(parts)

def extract_text_from_pptx(file_path: str) -> str:
    from pptx import Presentation
    prs = Presentation(file_path)
    parts = []
    for i, slide in enumerate(prs.slides, start=1):
        parts.append(f"--- Slide {i} ---")
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                parts.append(shape.text_frame.text)
    return "\n".join(parts)
```

- Rename `process_pdf_and_index` → `process_document_and_index(file_path: str, filename: str)`. Dispatch on file extension (`.pdf`, `.docx`, `.xlsx`/`.xls`, `.pptx`) to the matching extractor, then run the existing chunk/embed logic unchanged.
- Return value should stay compatible with the frontend's `totalChunks`/`totalPages` fields — for non-PDF formats, `totalPages` can represent sheet count / slide count / 1 (for docx), labeled generically as `totalUnits` if you want to be precise, but keep backward compatibility with the existing frontend field names unless the frontend is updated too (see §5.2).
- Wrap each extractor call in a try/except that raises a clear `Exception` message (e.g. `"Could not extract any text from this DOCX file."`) matching the existing PDF error pattern.

**`main.py`** — update the upload endpoint:
```python
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".xls", ".pptx"}

@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Please upload a PDF, DOCX, XLSX, or PPTX file."
        )
    # ... save file, then call process_document_and_index(file_path, file.filename)
```

### 5.2 Frontend changes required

- Update the file input: `accept="application/pdf,.docx,.xlsx,.xls,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"`.
- Replace the client-side `.pdf`-only validation with a check against the same allowed-extensions list as the backend.
- Update the "PDF ONLY" badge to something like "PDF · DOCX · XLSX · PPTX".
- Update the dropzone helper text and icon (e.g. swap the static 📄 for a per-type icon: 📄 PDF, 📝 DOCX, 📊 XLSX, 📽️ PPTX) based on the selected file's extension.
- Keep the existing upload/chat flow, loading states, and error handling — only the accepted-type surface changes.

---

## 6. API Contract (must remain stable)

### `POST /api/upload`
- Request: `multipart/form-data`, field `file`
- Success response:
  ```json
  {
    "success": true,
    "message": "string",
    "filename": "string",
    "totalPages": 0,
    "totalChunks": 0
  }
  ```
- Error response: HTTP 4xx/5xx with `{"detail": "string"}`

### `POST /api/chat`
- Request: `application/json`, body `{"question": "string"}`
- Success response: `{"success": true, "answer": "string"}`
- Error response: HTTP 4xx/5xx with `{"detail": "string"}`

---

## 7. Non-Functional Requirements

- **Security:** never log or echo the `GEMINI_API_KEY`. Keep it in `.env` / `.env.local` only, never commit it.
- **Error handling:** every extractor and API call must fail with a clear, user-readable message (no raw stack traces surfaced to the frontend).
- **State model:** the current in-memory `indexed_store` is single-document, single-session, and resets on backend restart — this is acceptable for the current single-user scope. Do not add persistence/multi-doc support unless explicitly requested; note it as a possible future enhancement instead.
- **Styling:** all styling must go through Tailwind utility classes already configured in `tailwind.config.ts` (indigo/slate palette, Arial font family, `@tailwindcss/typography` for markdown rendering). Do not reintroduce inline styles or a different CSS framework.
- **Language:** UI copy (buttons, labels, static text) stays in English. AI-generated answers must **adapt to the student's question language** — see §10.1 (this supersedes any earlier "always English" behavior).

---

## 8. Setup & Run

**Backend:**
```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

Env files required (not committed):
- `backend/.env` → `GEMINI_API_KEY=...`
- `frontend/.env.local` → `NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000`

---

## 9. Acceptance Criteria

- [ ] Uploading a `.pdf`, `.docx`, `.xlsx`, and `.pptx` file each succeed and return a valid chunk count.
- [ ] Chat works identically regardless of which format was uploaded.
- [ ] Uploading an unsupported format (e.g. `.txt`, `.jpg`) is rejected with a clear error, both client-side and server-side.
- [ ] All items in the §2 "Hard Constraints" table are verified unchanged.
- [ ] `npm run build` completes with no type errors.
- [ ] Manual test: full restart of both servers, upload each format, run "Detailed Summary", "5 Exam MCQs", and "5 Short Questions" against each, confirm English Markdown renders correctly (bold/lists, not raw asterisks).

---

## 10. Round 2 Requirements — Adaptive Language, Streaming, Copy, Quiz Generator

### 10.1 Adaptive Response Language

Replace the old "always respond in English" rule with language-matching: the AI should detect what language/script the student's question is written in and reply in the same one.

Update the prompt in `rag.py`:

```python
    prompt = f"""
You are StudyMate AI, a smart personalized academic tutor for students.
Answer the question based strictly on the provided document context below.

[DOCUMENT CONTEXT]:
{context_text}

[STUDENT QUESTION]:
{question}

[RESPONSE GUIDELINES]:
- Detect the language/script the STUDENT QUESTION is written in and reply
  fully in that same language:
  - If it's Roman Urdu (Urdu words typed in Latin/English letters), reply
    fully in Roman Urdu.
  - If it's written in Urdu script (Arabic script), reply fully in Urdu script.
  - If it's English, reply fully in English.
  - Never mix languages within a single response.
- Give a detailed, well-explained answer that teaches the concept, not just
  a terse fact — favor depth and clarity. Use examples where helpful.
- If asked for a summary, give at least 8-10 well-organized bullet points.
- If asked for MCQs, generate exactly the number requested, each with 4
  options, the correct answer clearly marked, and a one-line explanation.
- If asked for short-answer questions, generate exactly the number requested,
  each with a concise model answer.
- If asked to generate a QUIZ/PAPER (see §10.4), output ONLY the questions —
  never include answers or solutions in that response, even if the student's
  earlier messages included answers.
- Use bullet points, numbered lists, and bold for structure and key terms.
"""
```

Note: the frontend's own UI text (buttons, labels, placeholders, error toasts) stays in English regardless — only the AI's generated answer content adapts.

### 10.2 Response Streaming (for perceived speed)

Add a streaming chat endpoint so the answer starts rendering almost immediately instead of waiting for the full generation to complete.

**Backend (`rag.py`)** — add a generator-based variant:
```python
def answer_question_from_rag_stream(question: str):
    """Same retrieval logic as answer_question_from_rag, but yields text
    chunks as Gemini generates them."""
    if not indexed_store["chunks"]:
        raise Exception("Please upload and index a document first.")

    top_k = 6 if len(indexed_store["chunks"]) > 6 else len(indexed_store["chunks"])
    q_response = client.models.embed_content(model="gemini-embedding-001", contents=question)
    q_embedding = q_response.embeddings[0].values

    similarities = []
    for idx, emb in enumerate(indexed_store["embeddings"]):
        similarities.append((cosine_similarity(q_embedding, emb), indexed_store["chunks"][idx]))
    similarities.sort(key=lambda x: x[0], reverse=True)
    context_text = "\n\n--- Next Chunk ---\n\n".join(c for _, c in similarities[:top_k])

    prompt = f"... (same prompt template as above, with {context_text} and {question}) ..."

    for chunk in client.models.generate_content_stream(model="gemini-3.6-flash", contents=prompt):
        if chunk.text:
            yield chunk.text
```

**Backend (`main.py`)** — add a streaming route using `StreamingResponse`:
```python
from fastapi.responses import StreamingResponse
from app.rag import answer_question_from_rag_stream

@app.post("/api/chat/stream")
async def chat_with_pdf_stream(payload: ChatRequest):
    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    def event_generator():
        try:
            for piece in answer_question_from_rag_stream(payload.question):
                yield piece
        except Exception as e:
            yield f"\n\n[error] {str(e)}"

    return StreamingResponse(event_generator(), media_type="text/plain")
```

**Frontend (`page.tsx`)** — read the stream and update the message incrementally:
```typescript
const handleSendMessage = async (queryText?: string, opts?: { isQuiz?: boolean }) => {
  const question = queryText || inputQuery;
  if (!question.trim() || !isIndexed) return;

  setMessages((prev) => [...prev, { sender: "user", text: question }]);
  if (!queryText) setInputQuery("");
  setIsGenerating(true);

  // Insert an empty AI message we will fill in as chunks arrive
  const aiIndex = messages.length + 1;
  setMessages((prev) => [...prev, { sender: "ai", text: "", isQuiz: opts?.isQuiz, solved: false }]);

  try {
    const res = await fetch(`${BACKEND_URL}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
      setMessages((prev) => {
        const next = [...prev];
        next[aiIndex] = { ...next[aiIndex], text: accumulated };
        return next;
      });
    }
  } catch {
    setMessages((prev) => {
      const next = [...prev];
      next[aiIndex] = { sender: "ai", text: "Network error: the backend is not responding." };
      return next;
    });
  } finally {
    setIsGenerating(false);
  }
};
```
This makes the first visible text appear in roughly 1 second (network + first-token latency), even though a long, detailed answer may keep streaming in for several more seconds — which reads as fast and responsive rather than a blocking wait.

### 10.3 Copy Button on AI Messages

Each AI message bubble gets a small copy icon (visible on hover or always visible on mobile) that copies the raw answer text to the clipboard and shows brief "Copied" feedback.

```typescript
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className="text-xs text-slate-500 hover:text-indigo-300 transition-colors flex items-center gap-1"
      aria-label="Copy response"
    >
      {copied ? "✅ Copied" : "📋 Copy"}
    </button>
  );
}
```
Place it in the bottom-right corner of each AI bubble, below the rendered Markdown.

### 10.4 Quiz / Paper Generator with Deferred Solutions

New quick-action: **"Generate Quiz Paper"**. Behavior:

1. Student clicks the button (or types a request like "make a quiz paper").
2. AI generates **concept-based questions only** (mix of MCQs and short-answer, testing understanding rather than pure recall) — **no answers included** in this response. Enforce this via the prompt rule in §10.1 (`If asked to generate a QUIZ/PAPER... output ONLY the questions`).
3. That message renders with a **"📝 Show Solutions"** button attached beneath it (in addition to the copy button).
4. Clicking "Show Solutions" sends a **follow-up** request: `Provide detailed solutions and explanations for the following quiz questions, based on the document:\n\n${quizMessageText}` — reusing the same `/api/chat/stream` endpoint. The solutions arrive as a new AI message directly after.
5. Once solutions are requested, disable/hide the "Show Solutions" button on that quiz message (track via a `solved: boolean` flag on the message object) so it can't be double-triggered.

Extend the `Message` interface:
```typescript
interface Message {
  sender: "user" | "ai";
  text: string;
  isQuiz?: boolean;
  solved?: boolean;
}
```

Quick-action button:
```typescript
<button
  onClick={() =>
    handleSendMessage(
      "Generate a concept-based quiz paper with 5 questions from this document (mix of MCQs and short-answer). Do not include answers.",
      { isQuiz: true }
    )
  }
  className="text-xs bg-darkCard hover:bg-indigo-500/10 border border-slate-700 hover:border-indigo-500/50 text-slate-300 rounded-full px-4 py-2 transition-all whitespace-nowrap"
>
  🧾 Generate Quiz Paper
</button>
```

"Show Solutions" button, rendered conditionally inside the AI message bubble when `msg.isQuiz && !msg.solved`:
```typescript
<button
  onClick={() => {
    handleSendMessage(
      `Provide detailed solutions and explanations for the following quiz questions, based on the document:\n\n${msg.text}`
    );
    // mark this specific quiz message as solved so the button disappears
  }}
  className="mt-3 text-xs bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 rounded-full px-3 py-1.5 transition-all"
>
  📝 Show Solutions
</button>
```

### 10.5 Additional Professional Polish (suggested, not mandatory)

- Replace all `alert(...)` calls (e.g. "please upload a PDF first") with an inline toast/snackbar component instead of a native browser alert.
- Add a subtle typing cursor at the end of the AI bubble while a stream is still arriving.
- Add per-file-type icons in the upload dropzone and chat (📄 PDF, 📝 DOCX, 📊 XLSX, 📽️ PPTX) driven by the indexed file's extension.
- Add a drag-over highlight state on the dropzone (border/background change on `onDragEnter`/`onDragLeave`).
- Add a "Regenerate" icon button on AI messages to re-ask the same preceding user question.
- Ensure the whole layout is responsive down to mobile width (sidebar collapses to a top drawer below `md:` breakpoint) — the current fixed `w-80` sidebar assumes desktop only.

### 10.6 Acceptance Criteria — Round 2

- [ ] Asking a question in Roman Urdu returns a Roman Urdu answer; in Urdu script returns Urdu script; in English returns English — verified with at least one question of each.
- [ ] Answers begin rendering within ~1-2 seconds of sending (streaming works), even though full generation of a long answer may continue for several more seconds.
- [ ] Every AI message has a working copy button that copies the exact answer text.
- [ ] "Generate Quiz Paper" produces questions with zero answers/solutions present.
- [ ] "Show Solutions" on a quiz message produces a correct, complete solutions response and then hides itself on that message.
- [ ] All Round 1 acceptance criteria (§9) still pass.