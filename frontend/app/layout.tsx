import "./globals.css";

export const metadata = {
  title: "StudyMate AI - Academic Partner",
  description: "Personalized AI Tutor using Gemini RAG Engine",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-darkBg text-slate-100 antialiased font-sans">
        {children}
      </body>
    </html>
  );
}