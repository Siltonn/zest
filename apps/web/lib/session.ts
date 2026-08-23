"use client";

import { useQuery } from "@tanstack/react-query";
import { api, isUnauthorized, type Actor } from "./api";

/**
 * Who the browser is, according to the backend.
 *
 * The frontend deliberately holds no auth state of its own — there is no
 * cookie it can read (the session cookie is HttpOnly) and no client SDK — so
 * "am I signed in?" is a question only `/me` can answer. Demo mode is the
 * reason this cannot be shortcut: it authenticates in the guard rather than
 * with a cookie, so a visitor with no cookie at all may still be a signed-in
 * operator, and any check that looked at the browser would send them to a
 * sign-in page they do not need.
 */

export type Me = {
  user: { id: string; name: string; email: string; image: string | null } | null;
  actor: Actor;
  workspace: { id: string; name: string } | null;
  capabilities?: {
    llm: boolean;
    provider?: string;
    model?: string | null;
    cheapModel?: string | null;
    recall?: { enabled: true; model: string } | { enabled: false; reason: string };
  };
};

/** Exported because the 401 handler in `providers` re-asks this same query. */
export const SESSION_KEY = ["me"] as const;

export type Session = {
  /**
   * `error` is not `anonymous`: a backend that is down or broken says nothing
   * about whether the visitor has a session, and treating the two alike would
   * bounce a signed-in operator to sign-in every time the API hiccuped.
   */
  status: "loading" | "authenticated" | "anonymous" | "error";
  me: Me | null;
};

export function useSession(): Session {
  // Retries follow the app-wide policy in `providers`: a 401 is not retried,
  // so the redirect is immediate, while a network blip still gets a few goes.
  const { data, error, isFetching } = useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => api.get<Me>("/me"),
  });

  // Order matters here, and both of the first two lines are load-bearing.
  //
  // A 401 outranks whatever we last knew: when a session expires mid-visit the
  // cache still holds the profile it was fetched with, and reading that first
  // would report a signed-in user forever. But a refetch in flight outranks
  // the 401 in turn — a stale error sits in the cache after signing in, and
  // acting on it would send someone who just succeeded straight back to the
  // form they came from.
  if (isFetching) {
    return { status: data ? "authenticated" : "loading", me: data ?? null };
  }
  if (isUnauthorized(error)) return { status: "anonymous", me: null };
  if (data) return { status: "authenticated", me: data };
  if (error) return { status: "error", me: null };
  return { status: "loading", me: null };
}

/**
 * Where to send someone after they sign in. Only same-origin paths: `next`
 * arrives in a URL anyone can hand out, so anything else is an open redirect
 * wearing a helpful name.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}
