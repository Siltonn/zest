"use client";

import { Toast, ToastProvider } from "@heroui/react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { isUnauthorized } from "@/lib/api";
import { SESSION_KEY } from "@/lib/session";

/**
 * HeroUI v3 needs no global provider — it builds on react-aria-components and
 * ships plain CSS. So this is just the query cache.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          refetchOnWindowFocus: false,
          // Retrying a 401 cannot succeed — no credential is going to appear
          // between attempts — and it delays the redirect by the whole backoff
          // while the app sits there looking broken.
          retry: (attempt, error) => !isUnauthorized(error) && attempt < 3,
        },
      },
      queryCache: new QueryCache({
        onError: (error, query) => {
          // A session can end while the app is open — it expires, or it is
          // signed out in another tab — and the first sign of it is some
          // background refetch coming back 401. Re-ask `/me` so the gate in
          // `Chrome` learns about it and moves the visitor to sign in, instead
          // of leaving them in a shell where nothing loads.
          if (!isUnauthorized(error)) return;
          if (query.queryKey[0] === SESSION_KEY[0]) return; // that gate's own query
          void client.invalidateQueries({ queryKey: SESSION_KEY });
        },
      }),
    });
    return client;
  });

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
