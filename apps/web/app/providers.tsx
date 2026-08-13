"use client";

import { Toast, ToastProvider } from "@heroui/react";
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
      {/*
        Actions that run in the background need to say so somewhere.

        The render function is not optional: without it the region renders
        nothing and every `toast.*` call in the app queues a message that is
        never drawn — which looks exactly like a button that does nothing.
      */}
      <ToastProvider>
        {({ toast: queued }) => (
          <Toast toast={queued} variant={queued.content.variant}>
            <Toast.Indicator variant={queued.content.variant} />
            <Toast.Content>
              <Toast.Title>{queued.content.title}</Toast.Title>
              {queued.content.description && (
                <Toast.Description>{queued.content.description}</Toast.Description>
              )}
            </Toast.Content>
            <Toast.CloseButton />
          </Toast>
        )}
      </ToastProvider>
    </QueryClientProvider>
  );
}
