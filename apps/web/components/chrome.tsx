"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

/** Routes that stand alone — no nav, no workspace queries, no signed-in chrome. */
const BARE_ROUTES = ["/sign-in", "/sign-up"];

/**
 * Decides whether a page gets the application shell. Sign-in must not render
 * the sidebar, both because it looks wrong and because the shell's queries
 * would 401 in a loop for a visitor who is not signed in yet.
 */
export function Chrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (BARE_ROUTES.some((route) => pathname.startsWith(route))) {
    return <div className="px-6 py-10">{children}</div>;
  }

  return <AppShell>{children}</AppShell>;
}
