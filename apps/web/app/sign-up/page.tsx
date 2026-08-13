"use client";

import { Button, Card } from "@heroui/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, email, password }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Could not create that account.");
      }

      // A fresh account has no workspace yet; the backend creates one on first
      // sign-in so the user lands somewhere usable rather than on an error.
      router.push("/");
      router.refresh();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <div className="mb-6 text-center">
        <div className="text-3xl">🍋</div>
        <h1 className="mt-2 text-xl font-semibold">Create a workspace</h1>
      </div>

      <Card>
        <Card.Content className="pt-4">
          <form onSubmit={submit} className="space-y-3">
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="your name"
              className="w-full rounded-lg border border-default-200/60 bg-transparent px-3 py-2 text-sm"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-default-200/60 bg-transparent px-3 py-2 text-sm"
            />
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password (8 characters or more)"
              className="w-full rounded-lg border border-default-200/60 bg-transparent px-3 py-2 text-sm"
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" isPending={busy} className="w-full">
              Create account
            </Button>
          </form>
        </Card.Content>
        <Card.Footer className="justify-center text-sm opacity-60">
          Already have one?{" "}
          <Link href="/sign-in" className="ml-1 underline">
            Sign in
          </Link>
        </Card.Footer>
      </Card>
    </div>
  );
}
