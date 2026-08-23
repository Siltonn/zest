"use client";

import { Button, Card, Form } from "@heroui/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { ZestMark } from "@/components/icons";

/**
 * The human checkpoint in the MCP OAuth flow.
 *
 * An MCP client (Claude, an IDE) hits `/api/auth/mcp/authorize`; signed out,
 * the server parks the request and sends the browser here with the OAuth query
 * intact. Dynamic client registration means *anyone* can register a client, so
 * this page is deliberately the only thing between a registered client and a
 * token acting as you: it names where the token would go and demands an
 * explicit click — never an auto-redirect.
 *
 * Two details are about correctness rather than looks:
 *
 *  - Better Auth parks the authorization in an `oidc_login_prompt` cookie and
 *    resumes it on whatever response next signs the user in — hijacking that
 *    response with a 302 that (as of 1.6.x) *drops the session cookie*, and
 *    delivering the code somewhere no page is watching. This page carries the
 *    whole request in its own query string, so on mount it deletes that cookie
 *    (it is not HttpOnly) and owns the flow end to end. The sign-in POST also
 *    sets `redirect: "manual"` as a second fence: if the hook ever fires
 *    anyway, the stray code is discarded rather than followed cross-origin.
 *
 *  - Approval re-enters `/api/auth/mcp/authorize` by *document navigation*, so
 *    the resulting 302 to the client's redirect_uri happens at the top level —
 *    which is what loopback callbacks and claude.ai's callback page expect.
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

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null = still asking the server; false = needs sign-in. */
  const [sessionEmail, setSessionEmail] = useState<string | null | false>(null);

  useEffect(() => {
    // Take the parked flow away from Better Auth's resume hook — see the
    // header comment. The query string is the source of truth from here on.
    document.cookie = "oidc_login_prompt=; Max-Age=0; path=/";

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

  function approve() {
    // Document navigation on purpose — see the header comment. The consent
    // marker is what lets this request through the server's gate; it exists
    // so that *only* this click, never a bare link, completes a grant.
    const query = new URLSearchParams(params.toString());
    query.set("zest_consent", "1");
    window.location.href = `/api/auth/mcp/authorize?${query.toString()}`;
  }

  function deny() {
    // RFC 6749 §4.1.2.1: tell the client it was refused, don't just strand it.
    const url = new URL(redirectUri!);
    url.searchParams.set("error", "access_denied");
    const state = params.get("state");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  async function signInAndApprove(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // "manual" so a resumed authorization's 302 is dropped, not followed.
        redirect: "manual",
        body: JSON.stringify({ email, password }),
      });

      // An opaque redirect reports status 0; only a readable non-OK response
      // is a definite failure. Either way the session cookie tells the truth.
      if (res.status >= 400) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Those details did not work.");
      }

      const session = await fetch("/api/auth/get-session", {
        credentials: "include",
      }).then((r) => r.json().catch(() => null) as Promise<{ user?: unknown } | null>);
      if (!session?.user) throw new Error("Those details did not work.");

      approve();
    } catch (problem) {
      setError((problem as Error).message);
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
              <div className="flex gap-2">
                <Button onPress={approve} className="flex-1">
                  Authorize
                </Button>
                <Button variant="ghost" onPress={deny} className="flex-1">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Form onSubmit={signInAndApprove} className="space-y-4">
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
              <Button variant="ghost" onPress={deny} className="w-full">
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
