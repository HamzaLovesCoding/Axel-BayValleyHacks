"use client";

import { useState, type FormEvent } from "react";
import { BRAND } from "@/lib/site";

export default function PasscodePage() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const passcode = new FormData(form).get("passcode");
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode, next: new URLSearchParams(window.location.search).get("next") }),
      });
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") throw new Error("Bad reply");
      if (!response.ok) {
        setError("error" in body && typeof body.error === "string" ? body.error : "I couldn't unlock Axel. Try again.");
        return;
      }
      form.reset();
      const next = "next" in body && typeof body.next === "string" ? body.next : "/";
      window.location.assign(next);
    } catch { setError("I couldn't connect. Check your connection and try again."); }
    finally { setPending(false); }
  };

  return (
    <main className="grid min-h-svh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-sm font-medium text-muted">{BRAND}</p>
        <h1 className="text-3xl font-medium tracking-tight">Welcome back</h1>
        <p className="mt-3 text-base text-muted">Enter your passcode to use the arm.</p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <div>
            <label htmlFor="passcode" className="mb-2 block text-sm font-medium">Passcode</label>
            <input id="passcode" name="passcode" type="password" autoComplete="current-password"
              required maxLength={256} aria-invalid={!!error} aria-describedby={error ? "passcode-error" : undefined}
              className="min-h-12 w-full rounded-xl border border-line bg-surface px-4 text-base text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg" />
            {error && <p id="passcode-error" role="alert" className="mt-3 text-sm text-fg">{error}</p>}
          </div>
          <button type="submit" disabled={pending} className="min-h-12 w-full rounded-xl bg-fg px-5 py-3 text-base font-medium text-bg transition-opacity hover:opacity-85 active:opacity-75 disabled:opacity-50">
            {pending ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </div>
    </main>
  );
}
