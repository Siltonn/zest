"use client";

import { Button, Card, Form } from "@heroui/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { ZestMark } from "@/components/icons";

/**
 * The human checkpoint in the MCP OAuth flow.
 *
 * An MCP client (Claude, an IDE) hits `/api/auth/oauth2/authorize`. Better
 * Auth parks the whole authorization request into a *signed* query string and
 * sends the browser here — as the login page when there is no session, and as
 * the consent page once there is. Both roles land on this one page, which
 * tells them apart by asking whether a session exists.
 *
 * The signed query is the only state the flow has: no cookie, no server-side
 * parking slot. This page therefore never invents URLs of its own — it hands
 * `oauth_query` back verbatim on every call, and follows whatever `url` the
 * server returns. That is what makes the page safe to reload, to open twice,
 * or to arrive at from a cold browser.
 *
 * Dynamic client registration means *anyone* can register a client, so this
 * screen is deliberately the only thing between a registered client and a
 * token acting as you: it names where the token would go and demands an
 * explicit click. Better Auth enforces that too — it will not issue a code
 * without a matching row in `oauth_consents` — so the button here is the thing
 * that creates the row, never a formality on top of a decision already made.
 */
export default function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeInner />
    </Suspense>
  );
}

function AuthorizeInner() {
  const params = useSearchParams();
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  /** The signed authorization request, handed back untouched on every call. */
  const oauthQuery = params.toString();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null = still asking the server; false = needs sign-in. */
  const [sessionEmail, setSessionEmail] = useState<string | null | false>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/get-session", { credentials: "include" });
        const body = (await res.json().catch(() => null)) as {
          user?: { email?: string };
        } | null;
        if (!cancelled) setSessionEmail(body?.user?.email ?? false);
      } catch {
        if (!cancelled) setSessionEmail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Opened outside an OAuth flow — there is nothing to authorize.
  if (!clientId || !redirectUri) {
    return (
      <Shell>
        <Card>
          <Card.Content className="pt-5 text-sm opacity-70">
            This page completes a connection started by an MCP client (like
            Claude). Start the flow from the client — there is nothing to do
            here directly.
          </Card.Content>
        </Card>
      </Shell>
    );
  }

  const destination = describeDestination(redirectUri);

  /**
   * Every step of the flow answers with `{redirect, url}`, and the url is
   * either this page again with a refreshed signed query, or the client's
   * redirect_uri carrying the code. Following it with a document navigation is
   * what puts the final hop at the top level, which is what loopback callbacks
   * and claude.ai's callback page expect.
   */
  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...body, oauth_query: oauthQuery }),
    });
    const payload = (await res.json().catch(() => null)) as {
      url?: string;
      message?: string;
      error_description?: string;
    } | null;

    if (!res.ok) {
      throw new Error(
        payload?.message ?? payload?.error_description ?? "That did not work.",
      );
    }
    if (!payload?.url) throw new Error("The server did not say where to go next.");
    window.location.href = payload.url;
  }

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/oauth2/consent", { accept });
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  }

  /**
   * Cancelling before sign-in cannot go through `/oauth2/consent` — recording
   * a refusal still needs a session, so the endpoint answers 401. The client
   * is owed an answer either way (RFC 6749 §4.1.2.1), so this composes the one
   * redirect the page is allowed to build itself: an error, to a redirect_uri
   * the authorization server already validated against the client.
   */
  function declineBeforeSignIn() {
    const url = new URL(redirectUri!);
    url.searchParams.set("error", "access_denied");
    const state = params.get("state");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  async function signInAndContinue(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Sign-in carries the parked authorization, so Better Auth resumes it on
      // the same response — landing back here as the consent step, or straight
      // at the client when consent was already given.
      await post("/api/auth/sign-in/email", { email, password });
    } catch {
      setError("Those details did not work.");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Card>
        <Card.Content className="space-y-4 pt-5">
          <div className="text-sm">
            <p>
              An MCP client wants to connect to your Zest workspace. After you
              approve, it acts with your authority: reading the inbox, proposing
              posts, and approving work will all trace to your account.
            </p>
            <p className="mt-2 opacity-70">
              Tokens are sent to <span className="font-medium">{destination}</span>.
              If you did not just connect a client, close this page.
            </p>
          </div>

          {sessionEmail === null ? (
            <p className="text-sm opacity-60">Checking your session…</p>
          ) : sessionEmail ? (
            <div className="space-y-3">
              <p className="text-sm opacity-70">
                Signed in as <span className="font-medium">{sessionEmail}</span>
              </p>
              {error && <p className="text-sm text-danger">{error}</p>}
              <div className="flex gap-2">
                <Button
                  onPress={() => void decide(true)}
                  isPending={busy}
                  className="flex-1"
                >
                  Authorize
                </Button>
                <Button
                  variant="ghost"
                  onPress={() => void decide(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Form onSubmit={signInAndContinue} className="space-y-4">
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
                Sign in and authorize
              </Button>
              <Button variant="ghost" onPress={declineBeforeSignIn} className="w-full">
                Cancel
              </Button>
            </Form>
          )}
        </Card.Content>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center">
      <div className="mb-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <ZestMark className="size-6" />
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          Connect to Zest
        </h1>
      </div>
      {children}
    </div>
  );
}

/** Where the tokens will be sent, in words a person can judge. */
function describeDestination(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return "an application on this computer";
    }
    return url.origin;
  } catch {
    return redirectUri;
  }
}
