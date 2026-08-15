"use client";

import { Button, Card, Form } from "@heroui/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { ZestMark } from "@/components/icons";

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

      // The backend creates a workspace on first authenticated request, so a
      // new account lands somewhere usable rather than on an error.
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
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <ZestMark className="size-6" />
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          Create a workspace
        </h1>
      </div>

      <Card>
        <Card.Content className="pt-5">
          <Form onSubmit={submit} className="space-y-4">
            <Field
              label="Your name"
              value={name}
              onChange={setName}
              isRequired
              autoFocus
            />
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              isRequired
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              description="At least 8 characters"
              isRequired
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" isPending={busy} className="w-full">
              Create account
            </Button>
          </Form>
        </Card.Content>
        <Card.Footer className="justify-center text-sm opacity-60">
          Already have one?
          <Link href="/sign-in" className="ml-1 underline">
            Sign in
          </Link>
        </Card.Footer>
      </Card>
    </div>
  );
}
