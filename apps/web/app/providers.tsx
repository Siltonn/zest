"use client";

import { ToastProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * HeroUI v3 needs no global provider — it builds on react-aria-components and
 * ships plain CSS. So this is just the query cache.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Actions that run in the background need to say so somewhere. */}
      <ToastProvider />
    </QueryClientProvider>
  );
}
