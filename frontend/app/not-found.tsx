import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-darkBg text-slate-100">
      <h2 className="text-4xl font-bold text-accent">404 - Page Not Found</h2>
      <p className="mt-2 text-slate-400">This page does not exist.</p>
      <Link
        href="/"
        className="mt-6 rounded-xl bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white shadow-glow hover:bg-teal-500 transition-all"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}