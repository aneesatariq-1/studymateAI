"use client";

import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MindMap, { MindMapData } from "./MindMap";

interface Message {
  id: string;
  sender: "user" | "ai";
  text: string;
  isQuiz?: boolean;
  solved?: boolean;
  isMindMap?: boolean;
  mindMapData?: MindMapData;
}

const STORAGE_KEY = "studymate_session_v3";

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const WELCOME_MESSAGE: Message = {
  id: "welcome",
  sender: "ai",
  text: "Hi! I'm StudyMate AI. Upload your study document (**PDF, DOCX, XLSX, or PPTX**) and I'll generate answers, summaries, practice questions, quizzes, and mind maps from it in seconds.",
};

const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".xls", ".pptx"];

type Language = "auto" | "english" | "roman_urdu" | "urdu";

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "auto", label: "Auto (match my question)" },
  { value: "english", label: "English" },
  { value: "roman_urdu", label: "Roman Urdu" },
  { value: "urdu", label: "اردو (Urdu)" },
];

const GEMINI_BUSY_MESSAGE =
  "The AI is currently busy handling high demand. Please wait a few seconds and try again.";

function looksLikeRawApiError(text: string): boolean {
  const trimmed = text.trim();
  return (
    /['"]error['"]\s*:\s*\{/.test(trimmed) ||
    /['"]code['"]\s*:\s*503/.test(trimmed) ||
    /['"]code['"]\s*:\s*429/.test(trimmed) ||
    trimmed.includes("RESOURCE_EXHAUSTED") ||
    (trimmed.startsWith("{") && trimmed.includes("UNAVAILABLE"))
  );
}

function friendlyErrorText(raw: unknown, fallback = GEMINI_BUSY_MESSAGE): string {
  if (raw == null) return fallback;

  if (typeof raw === "object") {
    const maybeDetail = (raw as { detail?: unknown }).detail;
    if (typeof maybeDetail === "string") return friendlyErrorText(maybeDetail, fallback);
    return fallback;
  }

  if (typeof raw !== "string") return fallback;

  let text = raw.trim();
  const marker = "[error]";
  const markerIdx = text.lastIndexOf(marker);
  if (markerIdx !== -1) {
    text = text.slice(markerIdx + marker.length).trim();
  }

  if (looksLikeRawApiError(text)) return GEMINI_BUSY_MESSAGE;

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.detail === "string") return friendlyErrorText(parsed.detail, fallback);
    if (parsed?.error) return GEMINI_BUSY_MESSAGE;
    return fallback;
  } catch {
    return text || fallback;
  }
}

function displayStreamText(accumulated: string): string {
  const markerIdx = accumulated.lastIndexOf("[error]");
  if (markerIdx === -1) {
    return looksLikeRawApiError(accumulated) ? GEMINI_BUSY_MESSAGE : accumulated;
  }
  const before = accumulated.slice(0, markerIdx).replace(/\s+$/, "");
  const after = friendlyErrorText(accumulated.slice(markerIdx));
  return before ? `${before}\n\n${after}` : after;
}

/**
 * Cleans up common LLM markdown quirks before handing text to ReactMarkdown,
 * without touching anything inside fenced code blocks.
 */
function normalizeMarkdown(text: string): string {
  if (!text) return text;

  const segments = text.split(/(```[\s\S]*?```)/g);

  return segments
    .map((segment, i) => {
      const isCodeFence = i % 2 === 1;
      if (isCodeFence) return segment;

      let out = segment;
      out = out.replace(/^(#{1,6})([^\s#])/gm, "$1 $2");
      out = out.replace(/^#(?!#)\s/gm, "## ");
      out = out.replace(/([^\n])\n(#{2,6}\s)/g, "$1\n\n$2");
      out = out.replace(/(#{2,6}[^\n]*)\n([^\n#])/g, "$1\n\n$2");
      out = out.replace(/\*\*([^*\n]+)\*\*\s*:\s*/g, "**$1:** ");

      return out;
    })
    .join("");
}

const LANDING_FEATURES = [
  { icon: "💬", title: "Ask Anything", description: "Chat with your document and get grounded, cited-style answers." },
  { icon: "📌", title: "Detailed Summary", description: "Turn long notes into a structured overview of the key ideas." },
  { icon: "🎯", title: "Exam Practice", description: "Generate MCQs and short-answer questions for revision." },
  { icon: "🧾", title: "Quiz Paper", description: "Create a concept quiz first, then reveal solutions when ready." },
  { icon: "🧠", title: "Mind Map", description: "Visualize key concepts as a connected diagram" },
];

function getFileIcon(filename?: string | null): string {
  if (!filename) return "📄";
  const ext = "." + (filename.split(".").pop()?.toLowerCase() || "");
  switch (ext) {
    case ".pdf": return "📄";
    case ".docx": return "📝";
    case ".xlsx":
    case ".xls": return "📊";
    case ".pptx": return "📽️";
    default: return "📄";
  }
}

function getFileTypeName(filename?: string | null): string {
  if (!filename) return "Document";
  const ext = "." + (filename.split(".").pop()?.toLowerCase() || "");
  switch (ext) {
    case ".pdf": return "PDF";
    case ".docx": return "DOCX Document";
    case ".xlsx":
    case ".xls": return "Excel Spreadsheet";
    case ".pptx": return "PowerPoint Presentation";
    default: return "Document";
  }
}

// Bug fix: `ext in [".xlsx", ".xls"]` used JS's `in` operator, which checks
// array INDICES ("0", "1"), never the values — so this never matched and
// Excel uploads always fell through to "pages". Use .includes() instead.
function getUnitLabel(ext: string): string {
  if (ext === ".docx") return "document";
  if (ext === ".pptx") return "slides";
  if ([".xlsx", ".xls"].includes(ext)) return "sheets";
  return "pages";
}

// Strips out anything that isn't a well-formed message — guards against any
// corrupted/legacy localStorage data (including the null-hole bug fixed
// below) so the app can never crash rendering old saved sessions.
function sanitizeMessages(list: unknown): Message[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (m): m is Message =>
        !!m &&
        typeof m === "object" &&
        typeof (m as any).sender === "string" &&
        typeof (m as any).text === "string"
    )
    .map((m) => ({ ...m, id: m.id || makeId("restored") }));
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };
  return (
    <button
      onClick={handleCopy}
      type="button"
      className="text-xs text-slate-400 hover:text-teal-400 transition-colors flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-slate-800/60"
      aria-label="Copy response"
    >
      <span>{copied ? "✅" : "📋"}</span>
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, 3500);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="fixed top-5 right-5 z-50 flex items-center gap-3 bg-slate-900/95 border border-teal-500/50 text-slate-100 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md">
      <span className="text-lg">💡</span>
      <p className="text-sm font-medium">{message}</p>
      <button
        onClick={onClose}
        className="ml-2 text-slate-400 hover:text-slate-200 text-sm font-bold"
        aria-label="Close notification"
      >
        ✕
      </button>
    </div>
  );
}

const QUICK_BTN =
  "text-xs bg-darkCard hover:bg-teal-500/10 border border-borderColor hover:border-teal-500/50 text-slate-300 rounded-full px-4 py-2 transition-all whitespace-nowrap";

export default function StudyMateDashboard() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isIndexed, setIsIndexed] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [inputQuery, setInputQuery] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [language, setLanguage] = useState<Language>("auto");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";

  // Bumped every time "New Chat" starts a fresh session. Any in-flight
  // request captures the token active when it started; if the token has
  // since changed, that request's result is discarded instead of being
  // written into the new (shorter) messages array — this is what was
  // producing the sparse-array/localStorage-null crash.
  const sessionTokenRef = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const cleanMessages = sanitizeMessages(parsed?.messages);
        if (cleanMessages.length) setMessages(cleanMessages);
        if (parsed?.isIndexed) setIsIndexed(true);
        if (parsed?.fileName) setFileName(parsed.fileName);
        if (parsed?.uploadStatus) setUploadStatus(parsed.uploadStatus);
        if (LANGUAGE_OPTIONS.some((o) => o.value === parsed?.language)) {
          setLanguage(parsed.language as Language);
        }
      }
    } catch {
      // ignore corrupt storage — falls back to the default welcome state
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages, isIndexed, fileName, uploadStatus, language })
      );
    } catch {
      // storage full/unavailable — non-fatal, chat still works this session
    }
  }, [messages, isIndexed, fileName, uploadStatus, language, hydrated]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isGenerating]);

  const handleNewChat = () => {
    sessionTokenRef.current += 1; // invalidates any in-flight request
    localStorage.removeItem(STORAGE_KEY);
    setMessages([WELCOME_MESSAGE]);
    setIsIndexed(false);
    setFile(null);
    setFileName(null);
    setUploadStatus("");
    setInputQuery("");
    setIsGenerating(false);
  };

  // Safe helper: updates a message by id, never by array position, so it
  // can never write into the wrong (or a now-stale) slot.
  const updateMessageById = (id: string, patch: Partial<Message> | ((m: Message) => Message)) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? (typeof patch === "function" ? patch(m) : { ...m, ...patch }) : m
      )
    );
  };

  const processSelectedFile = async (selectedFile: File) => {
    const ext = "." + (selectedFile.name.split(".").pop()?.toLowerCase() || "");
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setUploadStatus("Unsupported file type. Please upload a PDF, DOCX, XLSX, or PPTX file.");
      setToastMessage("Please choose a supported file (.pdf, .docx, .xlsx, .pptx).");
      return;
    }

    const token = sessionTokenRef.current;
    setFile(selectedFile);
    setFileName(selectedFile.name);
    setIsUploading(true);
    setUploadStatus(`Processing and indexing ${getFileTypeName(selectedFile.name)}...`);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch(`${BACKEND_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (sessionTokenRef.current !== token) return; // a New Chat happened mid-upload

      if (res.ok && data.success) {
        setIsIndexed(true);
        if (data.detectedLanguage === "urdu") {
          setLanguage("urdu");
          setToastMessage("Urdu document detected. Answers will be in Urdu. You can change this from the language menu.");
        }
        const unitLabel = getUnitLabel(ext);

        setUploadStatus(`Indexed successfully! (${data.totalChunks} chunks processed)`);
        setMessages((prev) => [
          ...prev,
          {
            id: makeId("ai"),
            sender: "ai",
            text: `${getFileIcon(selectedFile.name)} Document **${selectedFile.name}** is ready! Indexed **${data.totalPages} ${unitLabel}** (${data.totalChunks} chunks). Ask me anything in English, Roman Urdu, or Urdu script!`,
          },
        ]);
      } else {
        setUploadStatus(
          friendlyErrorText(data.detail, data.detail || "Upload failed. Please try again.")
        );
      }
    } catch {
      if (sessionTokenRef.current !== token) return;
      setUploadStatus("Could not reach the backend server. Please check that FastAPI is running.");
    } finally {
      if (sessionTokenRef.current === token) setIsUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    processSelectedFile(selectedFile);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      processSelectedFile(droppedFile);
    }
  };

  const handleSendMessage = async (queryText?: string, opts?: { isQuiz?: boolean }) => {
    const question = queryText || inputQuery;
    if (!question.trim()) return;

    if (!isIndexed) {
      setToastMessage("Please upload and index a study document first!");
      return;
    }

    const token = sessionTokenRef.current;
    const aiMsgId = makeId("ai");

    setMessages((prev) => [
      ...prev,
      { id: makeId("user"), sender: "user", text: question },
      { id: aiMsgId, sender: "ai", text: "", isQuiz: opts?.isQuiz, solved: false },
    ]);
    if (!queryText) setInputQuery("");
    setIsGenerating(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, language }),
      });

      if (sessionTokenRef.current !== token) return; // New Chat fired mid-request — drop this response

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const errMsg = friendlyErrorText(errData?.detail ?? errData, GEMINI_BUSY_MESSAGE);
        if (sessionTokenRef.current === token) updateMessageById(aiMsgId, { text: errMsg });
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        if (sessionTokenRef.current !== token) return; // abandon stale stream writes
        accumulated += decoder.decode(value, { stream: true });
        updateMessageById(aiMsgId, { text: displayStreamText(accumulated) });
      }
    } catch {
      if (sessionTokenRef.current === token) {
        updateMessageById(aiMsgId, {
          text: "Network error: the backend is not responding. Please check that FastAPI is running.",
        });
      }
    } finally {
      if (sessionTokenRef.current === token) setIsGenerating(false);
    }
  };

  const handleShowSolutions = (quizMsg: Message) => {
    updateMessageById(quizMsg.id, { solved: true });
    handleSendMessage(
      `Provide detailed solutions and explanations for the following quiz questions, based on the document:\n\n${quizMsg.text}`
    );
  };

  const handleGenerateMindMap = async () => {
    if (!isIndexed) {
      setToastMessage("Please upload and index a study document first!");
      return;
    }

    const token = sessionTokenRef.current;
    const aiMsgId = makeId("ai");

    setMessages((prev) => [
      ...prev,
      { id: makeId("user"), sender: "user", text: "Generate a concept mind map from this document." },
      { id: aiMsgId, sender: "ai", text: "", isMindMap: true },
    ]);
    setIsGenerating(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/mindmap?language=${language}`);
      const payload = await res.json().catch(() => null);
      if (sessionTokenRef.current !== token) return;

      if (!res.ok || !payload?.success || !payload.data) {
        const errMsg = friendlyErrorText(
          payload?.detail ?? payload,
          "Could not generate a mind map. Please try again."
        );
        updateMessageById(aiMsgId, { text: errMsg, isMindMap: false });
        return;
      }

      updateMessageById(aiMsgId, {
        text: `Mind map: ${payload.data.central || "Document concepts"}`,
        isMindMap: true,
        mindMapData: payload.data,
      });
    } catch {
      if (sessionTokenRef.current === token) {
        updateMessageById(aiMsgId, {
          text: "Network error: the backend is not responding. Please check that FastAPI is running.",
          isMindMap: false,
        });
      }
    } finally {
      if (sessionTokenRef.current === token) setIsGenerating(false);
    }
  };

  // Extra safety net: even if something malformed ever slips into state
  // during a render, never let it reach .sender / .text below.
  const safeMessages = messages.filter(
    (m): m is Message => !!m && typeof m === "object" && typeof m.sender === "string"
  );

  const showLanding = !isIndexed && safeMessages.length <= 1;

  return (
    <div className="flex h-screen w-full bg-darkBg text-slate-100 font-sans overflow-hidden">
      {toastMessage && <Toast message={toastMessage} onClose={() => setToastMessage(null)} />}

      <aside className="w-80 border-r border-borderColor bg-darkSurface p-6 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-8">
            <div className="h-11 w-11 rounded-xl bg-gradient-to-tr from-teal-600 to-emerald-500 flex items-center justify-center text-white font-bold text-xl shadow-glow">
              S
            </div>
            <div>
              <h1 className="font-bold text-lg leading-tight">
                <span className="text-accent">StudyMate</span>{" "}
                <span className="text-slate-50">AI</span>
              </h1>
              <p className="text-[11px] text-slate-400 font-medium tracking-wide">AI Academic Partner</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Upload Study Material
              </label>
              <span className="text-[10px] font-bold text-teal-400 bg-teal-500/10 border border-teal-500/30 rounded-full px-2.5 py-1">
                PDF · DOCX · XLSX · PPTX
              </span>
            </div>

            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative border-2 border-dashed transition-all duration-300 rounded-2xl p-6 text-center cursor-pointer group ${
                isDragging
                  ? "border-teal-500 bg-teal-500/10"
                  : "border-borderColor hover:border-teal-500 bg-darkCard/60 hover:bg-darkCard"
              }`}
            >
              <input
                type="file"
                accept="application/pdf,.docx,.xlsx,.xls,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                onChange={handleFileUpload}
                disabled={isUploading}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
              <div className="space-y-3">
                <div className="text-3xl group-hover:scale-105 transition-transform duration-300">
                  {getFileIcon(fileName || file?.name)}
                </div>
                <p className="text-sm font-semibold text-slate-200 truncate">
                  {fileName || file?.name || "Choose or drop a study file"}
                </p>
                <p className="text-[11px] text-slate-500">Supports PDF, DOCX, XLSX, PPTX</p>
              </div>
            </div>

            {uploadStatus && (
              <div
                className={`p-3.5 rounded-xl text-xs font-medium flex items-center gap-2.5 border transition-all ${
                  isIndexed
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-600/30"
                    : isUploading
                    ? "bg-teal-500/10 text-teal-300 border-teal-600/30 animate-pulse"
                    : "bg-rose-500/10 text-rose-300 border-rose-600/30"
                }`}
              >
                <span className="text-base">{isIndexed ? "✅" : isUploading ? "⏳" : "⚠️"}</span>
                <span className="truncate">{uploadStatus}</span>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleNewChat}
          className="w-full flex items-center justify-center gap-2 rounded-xl border border-borderColor bg-darkCard hover:bg-teal-500/10 text-slate-300 text-sm font-medium py-2.5 transition-all"
        >
          <span>🔄</span> New Chat
        </button>
      </aside>

      <main className="flex-1 flex flex-col bg-darkBg relative">
        <div className="circuit-grid absolute inset-0 z-0 pointer-events-none" aria-hidden="true" />

        <header className="h-16 border-b border-borderColor px-8 flex items-center justify-between bg-darkSurface/50 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${isIndexed ? "bg-emerald-500 shadow-glow" : "bg-amber-500"}`} />
            <span className="text-sm font-medium text-slate-300">
              {isIndexed ? `${getFileTypeName(fileName)} Active & Indexed` : "Waiting for a study document..."}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>🌐 Response language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              aria-label="Response language"
              className="bg-darkCard border border-borderColor rounded-full px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-teal-500 cursor-pointer"
            >
              {LANGUAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </header>

        <div className="flex-1 overflow-y-auto p-8 space-y-6 z-10">
          {showLanding && (
            <div className="max-w-3xl mx-auto w-full">
              <h2 className="text-2xl font-bold text-accent mb-2">Your AI study partner</h2>
              <p className="text-sm text-slate-400 mb-6">
                Upload a PDF, DOCX, XLSX, or PPTX on the left, then chat, quiz, or map the concepts.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {LANDING_FEATURES.map((feature) => (
                  <div key={feature.title} className="bg-darkCard border border-borderColor rounded-2xl p-4 shadow-cardGlow">
                    <div className="text-xl mb-2">{feature.icon}</div>
                    <h3 className="text-sm font-semibold text-accent mb-1">{feature.title}</h3>
                    <p className="text-xs text-slate-400 leading-relaxed">{feature.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {safeMessages.map((msg, idx) => (
            <div key={msg.id} className={`flex gap-4 ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
              {msg.sender === "ai" && (
                <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-teal-600 to-emerald-500 flex items-center justify-center text-white text-sm font-bold shadow-glow flex-shrink-0">
                  AI
                </div>
              )}
              <div
                className={`${
                  msg.isMindMap && msg.mindMapData ? "max-w-4xl w-full" : "max-w-2xl"
                } rounded-2xl p-4 text-sm leading-relaxed ${
                  msg.sender === "user"
                    ? "bg-gradient-to-r from-teal-600 to-emerald-500 text-white rounded-br-none font-medium"
                    : "bg-darkCard border border-borderColor text-slate-200 rounded-bl-none"
                }`}
              >
                {msg.sender === "ai" ? (
                  <div>
                    {msg.isMindMap && msg.mindMapData ? (
                      <div>
                        <p className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">
                          Concept Mind Map
                        </p>
                        <MindMap data={msg.mindMapData} />
                      </div>
                    ) : msg.isMindMap && isGenerating && idx === safeMessages.length - 1 && !msg.text ? (
                      <p className="text-slate-400 animate-pulse">Building your mind map...</p>
                    ) : (
                      <div
                        dir="auto"
                        className="prose prose-sm prose-invert max-w-none font-sans
                          prose-p:my-2 prose-p:leading-relaxed
                          prose-headings:font-sans prose-headings:font-semibold prose-headings:text-slate-50
                          prose-headings:mt-4 prose-headings:mb-2 prose-headings:first:mt-0
                          prose-h2:text-base prose-h2:pb-1.5 prose-h2:border-b prose-h2:border-borderColor
                          prose-h3:text-sm prose-h3:text-teal-300
                          prose-strong:text-teal-300 prose-strong:font-bold
                          prose-em:text-slate-300
                          prose-li:my-1 prose-li:marker:text-teal-500
                          prose-ol:my-2 prose-ul:my-2
                          prose-hr:border-borderColor prose-hr:my-4
                          prose-blockquote:border-l-teal-500 prose-blockquote:text-slate-400 prose-blockquote:not-italic
                          prose-a:text-teal-300 prose-a:no-underline hover:prose-a:underline
                          prose-table:text-xs prose-th:text-teal-300 prose-th:border-borderColor prose-td:border-borderColor
                          prose-pre:bg-black prose-pre:border prose-pre:border-teal-900/40 prose-pre:rounded-xl prose-pre:p-3.5
                          prose-code:text-teal-300 prose-code:font-mono prose-code:text-xs prose-code:before:content-none prose-code:after:content-none"
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {normalizeMarkdown(
                            msg.text || (isGenerating && idx === safeMessages.length - 1 ? "Thinking..." : "")
                          )}
                        </ReactMarkdown>
                        {isGenerating && idx === safeMessages.length - 1 && !msg.isMindMap && (
                          <span className="inline-block w-2 h-4 ml-1 bg-teal-400 animate-pulse align-middle" />
                        )}
                      </div>
                    )}

                    {msg.isQuiz && !msg.solved && (
                      <button
                        onClick={() => handleShowSolutions(msg)}
                        className="mt-3 text-xs bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/40 text-teal-300 rounded-full px-3.5 py-1.5 transition-all flex items-center gap-1.5 active:scale-95 font-medium"
                      >
                        <span>📝</span> Show Solutions
                      </button>
                    )}

                    {msg.text && (
                      <div className="mt-3 pt-2 border-t border-borderColor flex justify-end">
                        <CopyButton text={msg.text} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div dir="auto" className="whitespace-pre-wrap">{msg.text}</div>
                )}
              </div>
            </div>
          ))}

          <div ref={chatEndRef} />
        </div>

        {isIndexed && (
          <div className="px-8 py-2 flex gap-2.5 overflow-x-auto z-10">
            <button
              onClick={() =>
                handleSendMessage(
                  "Give a detailed summary of this document in at least 8-10 bullet points, covering all major concepts."
                )
              }
              className={QUICK_BTN}
            >
              📌 Detailed Summary
            </button>
            <button
              onClick={() =>
                handleSendMessage(
                  "Generate 5 important exam MCQs from this document, each with 4 options, the correct answer, and a short explanation."
                )
              }
              className={QUICK_BTN}
            >
              🎯 5 Exam MCQs
            </button>
            <button
              onClick={() =>
                handleSendMessage(
                  "Generate 5 important short-answer exam questions from this document, each with a concise model answer."
                )
              }
              className={QUICK_BTN}
            >
              📝 5 Short Questions
            </button>
            <button
              onClick={() =>
                handleSendMessage(
                  "Generate a concept-based quiz paper with 5 questions from this document (mix of MCQs and short-answer). Do not include answers.",
                  { isQuiz: true }
                )
              }
              className={QUICK_BTN}
            >
              🧾 Generate Quiz Paper
            </button>
            <button onClick={handleGenerateMindMap} className={QUICK_BTN}>
              🧠 Generate Mind Map
            </button>
          </div>
        )}

        <footer className="p-6 border-t border-borderColor bg-darkSurface/40 backdrop-blur-md z-10">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex gap-3"
          >
            <input
              type="text"
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              placeholder={
                isIndexed
                  ? "Ask any question in English, Roman Urdu, or Urdu script..."
                  : "Please upload a study document from the left panel first..."
              }
              disabled={!isIndexed || isGenerating}
              className="flex-1 bg-darkCard border border-borderColor rounded-2xl px-5 py-3.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!isIndexed || isGenerating || !inputQuery.trim()}
              className="bg-gradient-to-r from-teal-600 to-emerald-500 hover:opacity-90 disabled:opacity-30 text-white font-semibold rounded-2xl px-7 py-3.5 text-sm transition-all shadow-glow flex items-center gap-2 active:scale-95"
            >
              <span>Ask</span>
              <span className="text-base">➔</span>
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}