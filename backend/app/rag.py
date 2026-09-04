import os
import math
import json
import time
import random
import logging
from pypdf import PdfReader
from google import genai
from dotenv import load_dotenv
import pytesseract
from pdf2image import convert_from_path

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise ValueError("GEMINI_API_KEY is missing in the backend/.env file!")

# Configure Tesseract + Poppler paths from .env (Windows needs explicit paths)
TESSERACT_PATH = os.getenv("TESSERACT_PATH")
POPPLER_PATH = os.getenv("POPPLER_PATH")
if TESSERACT_PATH:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_PATH

# Initialize Gemini Client
client = genai.Client(api_key=api_key)

logger = logging.getLogger("studymate.rag")

# Primary model + a slightly older/steadier sibling used only when the
# primary model is overloaded. Keeping a fallback means a demand spike on
# one model doesn't take the whole app down.
PRIMARY_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash")
EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")

# In-Memory Storage for Document Chunks & Embeddings
indexed_store = {
    "chunks": [],
    "embeddings": []
}

GEMINI_BUSY_MESSAGE = (
    "The AI is currently busy handling high demand. Please wait a few seconds and try again."
)


def _is_transient_error(error_str: str) -> bool:
    return (
        "503" in error_str
        or "UNAVAILABLE" in error_str
        or "429" in error_str
        or "RESOURCE_EXHAUSTED" in error_str
        or "overloaded" in error_str.lower()
        or "DEADLINE_EXCEEDED" in error_str
    )


def call_gemini_with_retry(fn, max_retries=4, base_delay=1.5, max_delay=12.0):
    """Calls fn() and retries on transient errors (503/UNAVAILABLE,
    429/rate limit, timeouts) using exponential backoff with jitter.
    Raises a clean, user-friendly exception if all retries are exhausted
    so raw provider errors never reach the API response or the frontend."""
    last_error = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            last_error = e
            error_str = str(e)
            is_transient = _is_transient_error(error_str)
            logger.warning(
                "Gemini call failed (attempt %s/%s, transient=%s): %s",
                attempt + 1, max_retries, is_transient, error_str,
            )
            if is_transient and attempt < max_retries - 1:
                delay = min(max_delay, base_delay * (2 ** attempt))
                delay += random.uniform(0, delay * 0.25)  # jitter
                time.sleep(delay)
                continue
            break
    logger.error("Gemini call exhausted retries: %s", last_error)
    raise Exception(GEMINI_BUSY_MESSAGE)


def call_gemini_with_fallback(fn_for_model, max_retries=4):
    """Runs fn_for_model(PRIMARY_MODEL) with retries; if that whole path is
    still failing (sustained overload), makes a second attempt against
    FALLBACK_MODEL before giving up. Only raises the friendly busy message."""
    try:
        return call_gemini_with_retry(lambda: fn_for_model(PRIMARY_MODEL), max_retries=max_retries)
    except Exception:
        if FALLBACK_MODEL and FALLBACK_MODEL != PRIMARY_MODEL:
            logger.warning("Primary model %s exhausted, trying fallback %s", PRIMARY_MODEL, FALLBACK_MODEL)
            try:
                return call_gemini_with_retry(lambda: fn_for_model(FALLBACK_MODEL), max_retries=2)
            except Exception:
                pass
        raise Exception(GEMINI_BUSY_MESSAGE)

def cosine_similarity(v1, v2):
    """Calculates similarity score between two vector embeddings"""
    dot_product = sum(a * b for a, b in zip(v1, v2))
    magnitude1 = math.sqrt(sum(a * a for a in v1))
    magnitude2 = math.sqrt(sum(b * b for b in v2))
    if not magnitude1 or not magnitude2:
        return 0.0
    return dot_product / (magnitude1 * magnitude2)

def _ocr_extract_from_pdf(file_path: str) -> tuple[str, int]:
    """Fallback for scanned/image-based PDFs: converts each page to an image
    (via Poppler) and runs Tesseract OCR on it (Urdu + English)."""
    try:
        convert_kwargs = {}
        if POPPLER_PATH:
            convert_kwargs["poppler_path"] = POPPLER_PATH

        images = convert_from_path(file_path, dpi=300, **convert_kwargs)
        full_text = ""
        for image in images:
            # 'urd+eng' lets Tesseract recognize both Urdu and English text
            # on the same page. Make sure urd.traineddata is installed.
            page_text = pytesseract.image_to_string(image, lang="urd+eng")
            if page_text:
                full_text += page_text + "\n"

        if not full_text.strip():
            raise Exception("Could not extract any text from this PDF.")
        return full_text, len(images)
    except Exception as e:
        if "Could not extract" in str(e):
            raise
        raise Exception(f"OCR failed while reading PDF file: {str(e)}")


def extract_text_from_pdf(file_path: str) -> tuple[str, int]:
    """Extracts full text and page count from a PDF file.
    Tries normal text extraction first (fast); if the PDF has no
    selectable text (i.e. it's scanned/image-based), falls back to OCR."""
    try:
        reader = PdfReader(file_path)
        full_text = ""
        for page in reader.pages:
            text = page.extract_text()
            if text:
                full_text += text + "\n"

        if not full_text.strip():
            # No selectable text found -> likely a scanned PDF, use OCR
            logger.info("No embedded text found in PDF, falling back to OCR: %s", file_path)
            return _ocr_extract_from_pdf(file_path)

        return full_text, len(reader.pages)
    except Exception as e:
        if "Could not extract" in str(e):
            raise
        # If pypdf itself throws (corrupt/unusual PDF), also try OCR before giving up
        try:
            return _ocr_extract_from_pdf(file_path)
        except Exception:
            raise Exception(f"Failed to read PDF file: {str(e)}")

def extract_text_from_docx(file_path: str) -> tuple[str, int]:
    """Extracts text from paragraphs and tables in a DOCX file."""
    try:
        from docx import Document
        doc = Document(file_path)
        parts = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                if row_text.strip():
                    parts.append(row_text)
        full_text = "\n".join(parts)
        if not full_text.strip():
            raise Exception("Could not extract any text from this DOCX file.")
        return full_text, 1
    except Exception as e:
        if "Could not extract" in str(e):
            raise
        raise Exception(f"Failed to read DOCX file: {str(e)}")

def extract_text_from_xlsx(file_path: str) -> tuple[str, int]:
    """Extracts text across all sheets and rows from an Excel file."""
    try:
        from openpyxl import load_workbook
        wb = load_workbook(file_path, data_only=True)
        parts = []
        for sheet in wb.worksheets:
            parts.append(f"--- Sheet: {sheet.title} ---")
            for row in sheet.iter_rows(values_only=True):
                row_text = " | ".join(str(cell) for cell in row if cell is not None)
                if row_text.strip():
                    parts.append(row_text)
        full_text = "\n".join(parts)
        if not full_text.strip():
            raise Exception("Could not extract any text from this spreadsheet.")
        return full_text, len(wb.worksheets)
    except Exception as e:
        if "Could not extract" in str(e):
            raise
        raise Exception(f"Failed to read spreadsheet file: {str(e)}")

def extract_text_from_pptx(file_path: str) -> tuple[str, int]:
    """Extracts text from all slide shapes in a PowerPoint file."""
    try:
        from pptx import Presentation
        prs = Presentation(file_path)
        parts = []
        for i, slide in enumerate(prs.slides, start=1):
            parts.append(f"--- Slide {i} ---")
            for shape in slide.shapes:
                if shape.has_text_frame and shape.text_frame.text.strip():
                    parts.append(shape.text_frame.text.strip())
        full_text = "\n".join(parts)
        if not full_text.strip():
            raise Exception("Could not extract any text from this presentation.")
        return full_text, len(prs.slides)
    except Exception as e:
        if "Could not extract" in str(e):
            raise
        raise Exception(f"Failed to read presentation file: {str(e)}")

def process_document_and_index(file_path: str, filename: str) -> tuple[int, int]:
    """Dispatches to format extractor, splits text into chunks, and computes Gemini embeddings."""
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        full_text, units = extract_text_from_pdf(file_path)
    elif ext == ".docx":
        full_text, units = extract_text_from_docx(file_path)
    elif ext in [".xlsx", ".xls"]:
        full_text, units = extract_text_from_xlsx(file_path)
    elif ext == ".pptx":
        full_text, units = extract_text_from_pptx(file_path)
    else:
        raise Exception(f"Unsupported file type: {ext}")

    chunk_size = 800
    overlap = 100
    chunks = []
    for i in range(0, len(full_text), chunk_size - overlap):
        chunk = full_text[i:i + chunk_size]
        if chunk.strip():
            chunks.append(chunk)

    if not chunks:
        raise Exception("Could not generate text chunks from this document.")

    embeddings = []
    for chunk in chunks:
        response = call_gemini_with_retry(
            lambda c=chunk: client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=c,
            )
        )
        embeddings.append(response.embeddings[0].values)

    indexed_store["chunks"] = chunks
    indexed_store["embeddings"] = embeddings

    return len(chunks), units

def process_pdf_and_index(file_path: str):
    """Backward compatibility alias for PDF indexing."""
    return process_document_and_index(file_path, file_path)

def _get_rag_context(question: str) -> str:
    """Retrieves top context chunks using cosine similarity.
    Uses top_k=4 for normal Q&A to cut prompt size and latency,
    and higher top_k (6) for broad tasks like summaries, MCQs, or quizzes.
    """
    if not indexed_store["chunks"]:
        raise Exception("Please upload and index a document first.")

    total_chunks = len(indexed_store["chunks"])
    q_lower = question.lower()
    is_broad_task = any(term in q_lower for term in [
        "summary", "summarize", "quiz", "paper", "mcq", "mcqs", "exam",
        "questions", "overview", "full document", "kholasa", "khulasa"
    ])
    target_k = 6 if is_broad_task else 4
    top_k = min(target_k, total_chunks)

    q_response = call_gemini_with_retry(
        lambda: client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=question,
        )
    )
    q_embedding = q_response.embeddings[0].values

    similarities = []
    for idx, emb in enumerate(indexed_store["embeddings"]):
        score = cosine_similarity(q_embedding, emb)
        similarities.append((score, indexed_store["chunks"][idx]))

    similarities.sort(key=lambda x: x[0], reverse=True)
    top_chunks = [item[1] for item in similarities[:top_k]]
    return "\n\n--- Next Chunk ---\n\n".join(top_chunks)

def _build_rag_prompt(context_text: str, question: str) -> str:
    """Builds the adaptive language prompt adhering to AGENTS.md §10.1 and prompt refinement guidelines."""
    return f"""You are StudyMate AI, a smart personalized academic tutor for students.
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
- Be detailed and well-explained, but avoid repetition, filler, or restating
  the question — every sentence should add information. Favor depth and clarity.
  Use examples where helpful.
- When an answer includes code, pseudocode, or syntax, it must always be in
  a proper fenced Markdown code block with a language tag (e.g. ```python),
  never inline or plain paragraph text.
- If asked for a summary, give at least 8-10 well-organized bullet points.
- If asked for MCQs, generate exactly the number requested, each with 4
  options, the correct answer clearly marked, and a one-line explanation.
- If asked for short-answer questions, generate exactly the number requested,
  each with a concise model answer.
- If asked to generate a QUIZ/PAPER (see §10.4), output ONLY the questions —
  never include answers or solutions in that response, even if the student's
  earlier messages included answers.
- Use bullet points, numbered lists, and bold for structure and key terms.

[MARKDOWN FORMATTING RULES — strict]:
- Only use "##" or "###" for section headings, never a bare "#". Always put
  exactly one space after the hash symbols (e.g. "## Key Concepts", never
  "##Key Concepts" or "#Key Concepts").
- Always leave one blank line before and after every heading, list, and
  code block — never attach a heading directly to the end of a sentence.
- For a labeled term or definition, format it as "**Label:** explanation"
  (bold label, colon immediately after the closing **, one space, then the
  text) — do not bold the colon itself and do not leave the label unbolded.
- Never output raw "#" characters as emphasis, bullets, or decoration —
  "#" is reserved for headings only.
- Keep heading levels consistent and shallow (## for main sections, ### for
  sub-points); do not nest more than two levels deep.
"""

def answer_question_from_rag(question: str) -> str:
    """Finds relevant context chunks and asks Gemini for the answer (non-streaming)."""
    context_text = _get_rag_context(question)
    prompt = _build_rag_prompt(context_text, question)

    response = call_gemini_with_fallback(
        lambda model: client.models.generate_content(model=model, contents=prompt)
    )
    return response.text

def answer_question_from_rag_stream(question: str):
    """Yields text chunks as Gemini generates them for low-latency streaming.

    Some Gemini SDK versions build the stream lazily, so a 503/overload error
    only surfaces on the *first* `next()` call rather than when the stream
    object is created. To make sure that error is still covered by our
    retry + fallback-model logic (instead of leaking a raw provider error),
    we force that first network round-trip inside `call_gemini_with_fallback`
    and only start yielding once we know the stream is actually healthy.
    """
    context_text = _get_rag_context(question)
    prompt = _build_rag_prompt(context_text, question)

    def open_stream(model):
        stream = client.models.generate_content_stream(model=model, contents=prompt)
        iterator = iter(stream)
        first_chunk = next(iterator, None)
        return iterator, first_chunk

    try:
        iterator, first_chunk = call_gemini_with_fallback(open_stream)
    except Exception:
        yield GEMINI_BUSY_MESSAGE
        return

    try:
        if first_chunk is not None and getattr(first_chunk, "text", None):
            yield first_chunk.text
        for chunk in iterator:
            if chunk.text:
                yield chunk.text
    except Exception as e:
        # A failure here means some output already streamed to the user,
        # so we can't silently retry with a fresh model without duplicating
        # text — just append a clean, friendly note instead of raw JSON.
        logger.warning("Stream interrupted mid-response: %s", e)
        yield f"\n\n{GEMINI_BUSY_MESSAGE}"

def generate_mind_map() -> dict:
    """Asks Gemini for a structured concept map JSON from indexed document chunks."""
    if not indexed_store["chunks"]:
        raise Exception("Please upload and index a document first.")

    top_k = 8 if len(indexed_store["chunks"]) > 8 else len(indexed_store["chunks"])
    context_text = "\n\n".join(indexed_store["chunks"][:top_k])

    prompt = f"""
You are StudyMate AI. Analyze the following document context and produce a concept mind map.

[DOCUMENT CONTEXT]:
{context_text}

Return ONLY valid JSON (no markdown fences, no extra commentary) in exactly this shape:
{{
  "central": "Main Topic Name",
  "branches": [
    {{"label": "Branch Concept", "children": ["Sub-point A", "Sub-point B"]}}
  ]
}}

Rules:
- 4 to 6 branches maximum.
- Each branch may have 0-3 children.
- Keep every label short (2-6 words).
- Output must be parseable JSON and nothing else — no ```json fences, no leading/trailing text.
"""
    response = call_gemini_with_fallback(
        lambda model: client.models.generate_content(model=model, contents=prompt)
    )
    raw = (response.text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw
        raw = raw.strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise Exception("Could not generate a valid mind map — please try again")
        try:
            data = json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            raise Exception("Could not generate a valid mind map — please try again")

    if not isinstance(data, dict) or "central" not in data or "branches" not in data:
        raise Exception("Could not generate a valid mind map — please try again")

    return data