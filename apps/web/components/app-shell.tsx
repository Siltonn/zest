"use client";

import { Badge, Button, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { api, type Workspace } from "@/lib/api";
import { useLiveEvents } from "@/lib/events";
import { relativeTime } from "@/lib/format";

const NAV = [
  { href: "/", label: "Dashboard", icon: "◇" },
  { href: "/inbox", label: "Inbox", icon: "◉", badge: true },
  { href: "/calendar", label: "Calendar", icon: "▤" },
  { href: "/compose", label: "Compose", icon: "✎" },
  { href: "/chat", label: "Chat", icon: "◍" },
  { href: "/memory", label: "Memory", icon: "❋" },
  { href: "/autonomy", label: "Autonomy", icon: "⚖" },
  { href: "/team", label: "Team", icon: "⚙" },
  { href: "/audit", label: "Audit", icon: "☷" },
  { href: "/pomelo", label: "Pomelo", icon: "🍊" },
  { href: "/accounts", label: "Accounts", icon: "⛓" },
  { href: "/settings", label: "Settings", icon: "⚒" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { connected, activity, lastRun } = useLiveEvents();

  const { data: workspace } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.get<Workspace>("/workspace"),
  });

  const { data: inbox } = useQuery({
    queryKey: ["inbox-count"],
    queryFn: () => api.get<{ count: number }>("/inbox/count"),
    refetchInterval: 30_000,
  });

  const fastForward = useMutation({
    mutationFn: () => api.post("/simulator/fast-forward", { days: 1 }),
    onSuccess: () => {
      // The worker needs a moment to release events; refresh once it has.
      setTimeout(() => {
        void api.post("/ingest/poll");
        void queryClient.invalidateQueries();
      }, 2500);
    },
  });

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-default-200/60 px-3 py-5">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2">
          <span className="text-xl">🍋</span>
          <div>
            <div className="text-sm font-semibold leading-tight">Zest</div>
            <div className="text-xs opacity-50 leading-tight">
              {workspace?.name ?? "…"}
            </div>
          </div>
        </Link>

        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                  active ? "bg-default-200/70 font-medium" : "hover:bg-default-100/70"
                }`}
              >
                <span className="w-4 text-center opacity-60">{item.icon}</span>
                <span className="flex-1">{item.label}</span>
                {item.badge && (inbox?.count ?? 0) > 0 && (
                  <Badge color="warning" size="sm" variant="soft">
                    {inbox?.count}
                  </Badge>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-4 space-y-2 px-1">
          {/* The control that makes a day of engagement visible in seconds. */}
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            isPending={fastForward.isPending}
            onPress={() => fastForward.mutate()}
          >
            ⏩ Fast-forward a day
          </Button>
          <div className="flex items-center gap-1.5 px-1 text-xs opacity-50">
            <span
              className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-400"}`}
            />
            {connected ? "live" : "reconnecting…"}
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {lastRun && (
          <div className="flex items-center gap-2 border-b border-default-200/60 bg-violet-500/5 px-6 py-2 text-sm">
            <Spinner size="sm" />
            <span className="font-medium capitalize">
              {lastRun.role ?? "agent"} — {lastRun.phase}
            </span>
            {lastRun.detail && <span className="opacity-60">{lastRun.detail}</span>}
          </div>
        )}
        <div className="px-8 py-6">{children}</div>
      </main>

      {activity.length > 0 && (
        <aside className="hidden w-64 shrink-0 border-l border-default-200/60 px-4 py-5 xl:block">
          <div className="mb-3 text-xs font-medium uppercase tracking-wide opacity-50">
            Activity
          </div>
          <div className="space-y-2">
            {activity.slice(0, 14).map((item) => (
              <div key={item.id} className="text-sm">
                <div className="leading-snug">{item.label}</div>
                <div className="text-xs opacity-40">{relativeTime(item.at)}</div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
