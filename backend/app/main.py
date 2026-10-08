import os
import shutil
import logging
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.rag import (
    process_document_and_index,
    answer_question_from_rag,
    answer_question_from_rag_stream,
    generate_mind_map,
)

logger = logging.getLogger("studymate")

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

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".xls", ".pptx"}


class ChatRequest(BaseModel):
    question: str
    language: str = "auto"  # auto | english | roman_urdu | urdu


@app.get("/")
def home():
    return {"status": "StudyMate AI Python Backend is Running!"}


# These endpoints are plain `def` (not `async def`) on purpose: indexing, OCR
# and Gemini calls are blocking, and FastAPI runs `def` endpoints in a thread
# pool so the server stays responsive while they work.

@app.post("/api/upload")
def upload_document(file: UploadFile = File(...)):
    filename = os.path.basename(file.filename or "")
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Please upload a PDF, DOCX, XLSX, or PPTX file.",
        )

    file_path = os.path.join(UPLOAD_DIR, filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        total_chunks, total_units, detected_language = process_document_and_index(file_path, filename)
        return {
            "success": True,
            "message": "Document successfully processed and indexed!",
            "filename": filename,
            "totalPages": total_units,
            "totalChunks": total_chunks,
            "detectedLanguage": detected_language,
        }
    except Exception as e:
        logger.exception("Upload/indexing failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat")
def chat_with_document(payload: ChatRequest):
    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")
    try:
        answer = answer_question_from_rag(payload.question, payload.language)
        return {"success": True, "answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat/stream")
def chat_with_document_stream(payload: ChatRequest):
    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    def event_generator():
        try:
            for piece in answer_question_from_rag_stream(payload.question, payload.language):
                yield piece
        except Exception as e:
            yield f"\n\n{str(e)}"

    return StreamingResponse(event_generator(), media_type="text/plain; charset=utf-8")


@app.get("/api/mindmap")
def mind_map(language: str = "auto"):
    try:
        data = generate_mind_map(language)
        return {"success": True, "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))