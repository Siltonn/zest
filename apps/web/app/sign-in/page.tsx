"use client";

import { Button, Card, Form } from "@heroui/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";

/**
 * Sign in.
 *
 * Better Auth exposes a plain JSON endpoint on the backend, so this is an
 * ordinary form rather than an SDK integration — which keeps the frontend free
 * of auth state and lets a self-hoster swap the provider without touching
 * these pages.
 */
export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Those details did not work.");
      }

      router.push("/");
      router.refresh();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center">
      <div className="mb-6 text-center">
        <div className="text-3xl">🍋</div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Sign in to Zest</h1>
      </div>

      <Card>
        <Card.Content className="pt-5">
          <Form onSubmit={submit} className="space-y-4">
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              isRequired
              autoFocus
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              isRequired
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" isPending={busy} className="w-full">
              Sign in
            </Button>
          </Form>
        </Card.Content>
        <Card.Footer className="justify-center text-sm opacity-60">
          No account?
          <Link href="/sign-up" className="ml-1 underline">
            Create one
          </Link>
        </Card.Footer>
      </Card>

      <p className="mt-4 text-center text-xs opacity-40">
        Running the demo seed? Sign in as demo@zest.local / zestdemo
      </p>
    </div>
  );
}
