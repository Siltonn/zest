import type { Actor, PostStatus } from "./api";

/**
 * Status presentation, shared by the calendar, inbox and post drawer.
 *
 * Fixed hues rather than theme tokens on purpose: this is a categorical scale —
 * amber means waiting, blue means scheduled, green means out the door — and
 * recolouring it with the accent would collapse eight distinguishable states
 * into eight shades of one. It is the one place in the UI that should *not*
 * follow the theme.
 *
 * The step, though, has to, and one step cannot serve both grounds. A flat
 * `-600` failed at both ends: blue hit 3.9:1 and violet 3.4:1 on the dark page,
 * while on white the bright hues fell over instead — amber 3.1:1, orange 3.5:1,
 * emerald 3.6:1. These are small labels, so the bar is 4.5:1. The `-700`/`-400`
 * pair clears it for every hue in both themes (worst case 4.7:1). The settled
 * states keep zinc-500 — they are meant to recede, and already clear the bar.
 *
 * Dots keep a single step: decorative shapes are held to 3:1, and the label
 * beside them carries the meaning anyway for anyone who cannot separate hues.
 */
export const STATUS_META: Record<
  PostStatus,
  { label: string; color: string; dot: string }
> = {
  draft: { label: "Draft", color: "text-zinc-500 dark:text-zinc-400", dot: "bg-zinc-400" },
  pending_approval: {
    label: "Needs review",
    color: "text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  needs_changes: {
    label: "Rework",
    color: "text-orange-700 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  approved: { label: "Approved", color: "text-sky-700 dark:text-sky-400", dot: "bg-sky-500" },
  scheduled: {
    label: "Scheduled",
    color: "text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  publishing: {
    label: "Publishing",
    color: "text-violet-700 dark:text-violet-400",
    dot: "bg-violet-500",
  },
  published: {
    label: "Published",
    color: "text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  failed: { label: "Failed", color: "text-red-700 dark:text-red-400", dot: "bg-red-500" },
  rejected: {
    label: "Rejected",
    color: "text-zinc-500 dark:text-zinc-400",
    dot: "bg-zinc-300",
  },
  expired: { label: "Expired", color: "text-zinc-500 dark:text-zinc-400", dot: "bg-zinc-300" },
  canceled: {
    label: "Canceled",
    color: "text-zinc-500 dark:text-zinc-400",
    dot: "bg-zinc-300",
  },
};

/** Who did it, in words — the audit trail is meant to be read, not decoded. */
export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return "you";
    case "agent":
      return actor.role ? `the ${actor.role}` : "the agent";
    case "system":
      return "the scheduler";
    case "mcp":
      return "an MCP client";
    case "api":
      return "an API client";
  }
}

/** Five actor kinds, five hues — same categorical reasoning as `STATUS_META`. */
export function actorBadge(actor: Actor): { label: string; color: string } {
  switch (actor.kind) {
    case "human":
      return { label: "human", color: "bg-sky-500/15 text-sky-700 dark:text-sky-400" };
    case "agent":
      return {
        label: actor.role ?? "agent",
        color: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
      };
    case "system":
      return { label: "system", color: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400" };
    case "mcp":
      return { label: "mcp", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
    case "api":
      return { label: "api", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };
  }
}

export function relativeTime(iso: string | Date | number): string {
  const then = typeof iso === "string" || typeof iso === "number" ? new Date(iso) : iso;
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);

  if (Math.abs(seconds) < 60) return seconds >= 0 ? "just now" : "in a moment";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) {
    return minutes > 0 ? `${minutes}m ago` : `in ${-minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return hours > 0 ? `${hours}h ago` : `in ${-hours}h`;
  const days = Math.round(hours / 24);
  return days > 0 ? `${days}d ago` : `in ${-days}d`;
}

export function formatDateTime(iso: string | Date, timeZone?: string): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}
