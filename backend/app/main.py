import os
import shutil
import logging
import traceback
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.rag import (
    process_document_and_index,
    process_pdf_and_index,
    answer_question_from_rag,
    answer_question_from_rag_stream,
    generate_mind_map,
)

logger = logging.getLogger("studymate.main")

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

@app.get("/")
def home():
    return {"status": "StudyMate AI Python Backend is Running!"}

@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Please upload a PDF, DOCX, XLSX, or PPTX file."
        )

    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        total_chunks, total_pages = process_document_and_index(file_path, file.filename)
        format_name = ext[1:].upper()
        return {
            "success": True,
            "message": f"{format_name} successfully processed and indexed!",
            "filename": file.filename,
            "totalPages": total_pages,
            "totalChunks": total_chunks
        }
    except Exception as e:
        logger.error("Upload failed for %s: %s", file.filename, e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
async def chat_with_pdf(payload: ChatRequest):
    if not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    try:
        answer = answer_question_from_rag(payload.question)
        return {"success": True, "answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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

@app.get("/api/mindmap")
async def mind_map():
    try:
        data = generate_mind_map()
        return {"success": True, "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))