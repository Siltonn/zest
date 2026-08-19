"use client";

import { Button, Chip, Separator, Spinner, Tooltip } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { api, type Workspace } from "@/lib/api";
import { useLiveEvents } from "@/lib/events";
import { relativeTime } from "@/lib/format";
import { UserMenu } from "./user-menu";
import {
  AccountsIcon,
  AuditIcon,
  AutonomyIcon,
  CalendarIcon,
  PlansIcon,
  ChatIcon,
  ComposeIcon,
  DashboardIcon,
  InboxIcon,
  LabIcon,
  MemoryIcon,
  PomeloIcon,
  SettingsIcon,
  SidebarIcon,
  TeamIcon,
  ZestMark,
} from "./icons";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  badge?: boolean;
};

/**
 * Navigation grouped by what you are doing, not by an alphabet. Daily work
 * first, then the agent's own surfaces, then the things you set up once.
 */
const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      { href: "/", label: "Dashboard", icon: DashboardIcon },
      { href: "/inbox", label: "Inbox", icon: InboxIcon, badge: true },
      { href: "/plans", label: "Plans", icon: PlansIcon },
      { href: "/calendar", label: "Calendar", icon: CalendarIcon },
      { href: "/compose", label: "Compose", icon: ComposeIcon },
    ],
  },
  {
    label: "Agent",
    items: [
      { href: "/chat", label: "Chat", icon: ChatIcon },
      { href: "/memory", label: "Memory", icon: MemoryIcon },
      { href: "/autonomy", label: "Autonomy", icon: AutonomyIcon },
      { href: "/team", label: "Team", icon: TeamIcon },
      { href: "/lab", label: "Lab", icon: LabIcon },
    ],
  },
  {
    label: "Platform",
    items: [
      { href: "/pomelo", label: "Pomelo", icon: PomeloIcon },
      { href: "/audit", label: "Audit", icon: AuditIcon },
      { href: "/accounts", label: "Accounts", icon: AccountsIcon },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

/**
 * Routes that own their scrolling and pin content to the viewport edge —
 * chat's composer belongs at the bottom of the screen, not floating above a
 * page gutter.
 */
const FULL_BLEED = ["/chat"];

const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/inbox": "Inbox",
  "/calendar": "Calendar",
  "/compose": "Compose",
  "/chat": "Chat",
  "/memory": "Memory",
  "/autonomy": "Autonomy",
  "/team": "Team",
  "/lab": "Lab",
  "/audit": "Audit",
  "/pomelo": "Pomelo",
  "/accounts": "Accounts",
  "/settings": "Settings",
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { connected, activity, lastRun } = useLiveEvents();
  const [collapsed, setCollapsed] = useState(false);

  const { data: workspace } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.get<Workspace>("/workspace"),
  });

  const { data: inbox } = useQuery({
    queryKey: ["inbox-count"],
    queryFn: () => api.get<{ count: number }>("/inbox/count"),
    refetchInterval: 30_000,
  });

  const fullBleed = FULL_BLEED.some((route) => pathname.startsWith(route));

  const section = GROUPS.find((group) =>
    group.items.some((item) =>
      item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
    ),
  );
  const title = TITLES[pathname] ?? crumbFromPath(pathname);

  return (
    <div className="flex h-screen gap-3 bg-default-100/40 p-3">
      <aside
        className={`flex shrink-0 flex-col rounded-2xl border border-default-200/50 bg-[var(--background)] transition-[width] duration-200 ${
          collapsed ? "w-[68px]" : "w-64"
        }`}
      >
        {/* Brand block: a mark you can find at a glance, plus who you are in. */}
        <div className="flex items-center gap-3 px-4 py-4">
          <Link
            href="/"
            // The accent, not `bg-foreground`: that inverted between themes —
            // a black tile on light, a white one on dark — so the logo had no
            // stable identity. This is the one place the accent means "this is
            // Zest" rather than "this is the action", and it looks it.
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground"
            aria-label="Zest home"
          >
            <ZestMark className="size-5" />
          </Link>
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight">Zest</div>
              <div className="truncate text-xs leading-tight opacity-50">
                {workspace?.name ?? "…"}
              </div>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-2">
          {GROUPS.map((group, index) => (
            <div key={group.label}>
              {index > 0 && <Separator className="my-3 opacity-55" />}
              {!collapsed && (
                <div className="px-2 pb-1 pt-1 text-xs font-medium opacity-55">
                  {group.label}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);
                  const count = item.badge ? (inbox?.count ?? 0) : 0;

                  const link = (
                    <Link
                      href={item.href}
                      className={`flex items-center gap-3 rounded-lg px-2 py-2 text-[15px] transition-colors ${
                        active
                          ? "bg-default-200/70 font-medium"
                          : "opacity-75 hover:bg-default-100 hover:opacity-100"
                      } ${collapsed ? "justify-center" : ""}`}
                    >
                      <item.icon className="size-[18px] shrink-0" />
                      {!collapsed && <span className="flex-1">{item.label}</span>}
                      {/*
                        A Chip, not a Badge. HeroUI's Badge is absolutely
                        positioned to the top-right of the element it decorates,
                        and this Link is not a positioned ancestor — so the
                        inbox count escaped to the top-right corner of the page
                        and sat there, alone, over nothing. The count wants to
                        be inline at the end of the row anyway.
                      */}
                      {!collapsed && count > 0 && (
                        <Chip color="warning" size="sm" variant="soft">
                          {count}
                        </Chip>
                      )}
                    </Link>
                  );

                  // Collapsed, the label has to come from somewhere.
                  return collapsed ? (
                    <Tooltip key={item.href} delay={200}>
                      <Tooltip.Trigger>{link}</Tooltip.Trigger>
                      <Tooltip.Content>{item.label}</Tooltip.Content>
                    </Tooltip>
                  ) : (
                    <div key={item.href}>{link}</div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-2 px-3 pb-3">
          <Separator className="opacity-55" />
          <UserMenu collapsed={collapsed} />
          {!collapsed && (
            <div className="flex items-center gap-1.5 px-1 text-xs opacity-55">
              <span
                className={`size-1.5 rounded-full ${
                  connected ? "bg-success" : "bg-default-400"
                }`}
              />
              {connected ? "Live" : "Reconnecting…"}
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-default-200/50 bg-[var(--background)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-default-200/50 px-4 py-3">
          <Button
            size="sm"
            variant="tertiary"
            isIconOnly
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onPress={() => setCollapsed((c) => !c)}
          >
            <SidebarIcon className="size-4" />
          </Button>

          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
            {section && (
              <>
                <span className="opacity-55">{section.label}</span>
                <span className="opacity-25">/</span>
              </>
            )}
            <span className="font-medium">{title}</span>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {lastRun && (
              <div className="flex items-center gap-2 rounded-full bg-default-100 px-3 py-1 text-xs">
                <Spinner size="sm" />
                <span className="capitalize">
                  {lastRun.role ?? "agent"} · {lastRun.phase}
                </span>
              </div>
            )}
          </div>
        </header>

        {fullBleed ? (
          <div className="min-h-0 flex-1">{children}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[1600px] gap-6 px-8 py-6">
              <div className="min-w-0 flex-1">{children}</div>

              {activity.length > 0 && (
                <aside className="hidden w-60 shrink-0 2xl:block">
                  <div className="sticky top-0">
                    <div className="mb-2 text-xs font-medium opacity-55">
                      Activity
                    </div>
                    <div className="space-y-2.5">
                      {activity.slice(0, 12).map((item) => (
                        <div key={item.id} className="text-sm">
                          <div className="leading-snug opacity-80">{item.label}</div>
                          <div className="text-xs opacity-35">
                            {relativeTime(item.at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </aside>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nested routes (a Pomelo post) still deserve a sensible crumb. */
function crumbFromPath(pathname: string): string {
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  if (/^[0-9a-f-]{36}$/i.test(last)) return "Detail";
  return last.charAt(0).toUpperCase() + last.slice(1);
}
