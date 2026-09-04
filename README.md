# StudyMate AI

**Your Personalized Learning Assistant** — turns any lecture document into instant, grounded answers, quizzes, and mind maps.

StudyMate AI is a Retrieval-Augmented Generation (RAG) powered study companion. Upload a PDF, DOCX, XLSX, or PPTX — including **scanned/image-based Urdu PDFs** — and ask questions in English, Roman Urdu, or Urdu script. Every answer is generated strictly from your document, streamed back in real time.

---

## ✨ Features

- 📥 **Multi-format ingestion** — PDF, DOCX, XLSX, PPTX
- 🔤 **Urdu OCR support (new)** — scanned/image-based PDFs are converted to page images via **Poppler** and read with **Tesseract OCR** (`urd+eng`), so even non-selectable Urdu text becomes searchable
- 💬 **Grounded RAG chat** — answers come strictly from the uploaded document, reducing hallucination
- 🌐 **Adaptive language matching** — replies in whichever language you asked in (English / Roman Urdu / Urdu script)
- ⚡ **Streaming responses** — answers begin appearing within seconds
- 🔁 **Automatic retry & fallback** — handles temporary AI service overload gracefully
- 🧾 **Quiz generation** — auto-generated MCQs and short-answer questions, with deferred solutions for real self-testing
- 🗺️ **Mind map generation** — visual concept maps built directly from the document

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14 (App Router), TypeScript, Tailwind CSS, React Markdown |
| **Backend** | FastAPI (Python), Uvicorn, SSE streaming |
| **AI Engine** | Google Gemini API (`gemini-embedding-001`, `gemini-3.6-flash`) |
| **Document Parsing** | `pypdf`, `python-docx`, `openpyxl`, `python-pptx` |
| **OCR Pipeline** | `pytesseract` + Tesseract OCR (`urd+eng`), `pdf2image` + Poppler |
| **Data Layer** | In-memory vector store, cosine-similarity retrieval |

---

## 🔄 How It Works

```
Upload Document → Extract & Chunk (OCR fallback for scans) → Embed
      → Ask a Question → Retrieve Matches → Stream the Answer
```

1. **Upload** a PDF, DOCX, XLSX, or PPTX file.
2. **Extract & Chunk** — `pypdf` tries direct text extraction first. If the PDF has no selectable text (i.e. it's scanned), it automatically falls back to OCR: Poppler converts each page to an image, and Tesseract OCR reads it with the `urd+eng` language pack.
3. **Embed** — each chunk is converted into a vector using Gemini's embedding model.
4. **Ask a question** in English, Roman Urdu, or Urdu script.
5. **Retrieve** the most relevant chunks via cosine similarity.
6. **Stream** a grounded, language-matched answer back — generated only from retrieved context, never from general knowledge alone.

---

## 📋 Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.10+
- **Tesseract OCR** (with the Urdu language pack) — [Windows installer](https://github.com/UB-Mannheim/tesseract/wiki)
- **Poppler** (Windows binaries) — [download](https://github.com/oschwartz10612/poppler-windows/releases/latest)
- A **Google Gemini API key** — [get one here](https://aistudio.google.com/apikey)

---

## ⚙️ Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR-USERNAME/studymateai.git
cd studymateai
```

### 2. Backend setup

```bash
cd backend
python -m venv venv

# Windows
.\venv\Scripts\activate

# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
```

### 3. Configure environment variables

Create a `.env` file inside the `backend` folder:

```dotenv
GEMINI_API_KEY=your_gemini_api_key_here

# Windows only — full paths to your Tesseract and Poppler installs
TESSERACT_PATH=C:\Program Files\Tesseract-OCR\tesseract.exe
POPPLER_PATH=C:\path\to\poppler-xx.xx.x\Library\bin
```

> On macOS/Linux, Tesseract and Poppler are usually available directly on `PATH` after installing via Homebrew/apt, so `TESSERACT_PATH`/`POPPLER_PATH` can often be left unset.

### 4. Run the backend

```bash
uvicorn main:app --reload --port 8000
```

Backend runs at `http://127.0.0.1:8000`.

### 5. Frontend setup

```bash
cd ../frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:3000`.

---

## 📁 Project Structure

```
studymateai/
├── backend/
│   ├── app/
│   │   └── rag.py          # Document extraction, OCR fallback, RAG logic
│   ├── main.py              # FastAPI routes
│   ├── requirements.txt
│   └── .env                 # Not committed — see Setup above
├── frontend/
│   ├── app/
│   ├── package.json
│   └── ...
└── README.md
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `POST` | `/api/upload` | Upload and index a document (PDF/DOCX/XLSX/PPTX) |
| `POST` | `/api/chat` | Ask a question (non-streaming) |
| `POST` | `/api/chat/stream` | Ask a question (streamed response) |
| `GET` | `/api/mindmap` | Generate a concept mind map from the indexed document |

---

## 🗺️ Roadmap

- **Phase 1** — Multi-document library with persistent chat history
- **Phase 2** — Voice-based questions and spoken answers
- **Phase 3** — Collaborative study groups with shared document workspaces

---

## 👤 Author

**Aneesa Tariq**
PMAS Arid Agriculture University, Rawalpindi

---

## 📄 License

This project was built for an AI hackathon. Add your preferred license here (e.g. MIT).
