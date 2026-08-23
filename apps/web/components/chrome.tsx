"use client";

import { Spinner } from "@heroui/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useSession } from "@/lib/session";
import { AppShell } from "./app-shell";

/**
 * Routes that stand alone — no nav, no workspace queries, no signed-in chrome.
 *
 * `/authorize` is here because it is reached *while signed out*: an MCP client
 * sends the browser there to be approved, and the page carries its own sign-in
 * form. Wrapping it in the shell both looked wrong and, once this file started
 * redirecting visitors who have no session, would have bounced the OAuth flow
 * to a sign-in page that drops the parked authorization on the floor.
 */
const BARE_ROUTES = ["/sign-in", "/sign-up", "/authorize"];

/**
 * Decides whether a page gets the application shell, and whether the visitor
 * gets a page at all.
 */
export function Chrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (BARE_ROUTES.some((route) => pathname.startsWith(route))) {
    return <div className="px-6 py-10">{children}</div>;
  }

  return <Guarded>{children}</Guarded>;
}

/**
 * The application, once we know someone is behind it.
 *
 * Nothing renders until `/me` answers, and that ordering is the fix rather
 * than an optimisation: mounting the shell first meant a signed-out visitor
 * got the full app, every page firing queries that 401 in a loop, an inbox
 * badge stuck at nothing and an account menu offering to sign them *out* of a
 * session they never had — with no route to the sign-in page anywhere on
 * screen. A separate component so the hook below never runs on the bare
 * routes, which include the sign-in page this redirects to.
 */
function Guarded({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useSession();

  useEffect(() => {
    if (status !== "anonymous") return;
    // Carry where they were headed, so signing in lands them there rather
    // than dumping them on the dashboard.
    const here = pathname + window.location.search;
    router.replace(
      here === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(here)}`,
    );
  }, [status, pathname, router]);

  if (status === "loading" || status === "anonymous") {
    return (
      <div className="grid h-screen place-items-center" aria-busy>
        <Spinner />
      </div>
    );
  }

  // A backend that is unreachable is not the same as a missing session: show
  // the app and let each page report its own failure.
  return <AppShell>{children}</AppShell>;
}
