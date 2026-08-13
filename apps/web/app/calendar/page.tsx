"use client";

import { Button, Card, Skeleton, Tooltip } from "@heroui/react";
import { Segmented } from "@/components/segmented";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Post } from "@/lib/api";
import { PostDrawer } from "@/components/post-drawer";
import { STATUS_META, formatDateTime } from "@/lib/format";

type View = "month" | "week";

/**
 * The publishing calendar.
 *
 * Month is the default because content planning is a month-shaped activity —
 * you want to see gaps and clusters, not five days. Week exists for the days
 * you are actually working in. Dragging a post to another day reschedules it
 * through the state machine, so the move is audited like any other transition.
 */
export default function CalendarPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const { data: posts = [], isLoading } = useQuery({
    queryKey: ["posts"],
    queryFn: () => api.get<Post[]>("/posts"),
  });

  const reschedule = useMutation({
    mutationFn: ({ id, when }: { id: string; when: Date }) =>
      api.post(`/posts/${id}/schedule`, { scheduledAt: when.toISOString() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posts"] }),
  });

  const days = view === "month" ? monthGrid(anchor) : weekGrid(anchor);
  const unscheduled = posts.filter((p) => p.status === "approved" && !p.scheduledAt);
  const dated = posts.filter((p) => p.scheduledAt ?? p.publishedAt);

  const move = (day: Date) => {
    if (!dragging) return;
    const post = posts.find((p) => p.id === dragging);
    // Keep the time of day; only the date changes.
    const previous = post?.scheduledAt ? new Date(post.scheduledAt) : new Date();
    const when = new Date(day);
    when.setHours(previous.getHours(), previous.getMinutes(), 0, 0);
    reschedule.mutate({ id: dragging, when });
    setDragging(null);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
          <p className="text-sm opacity-60">
            Drag a post to another day to move it. Everything here is approved.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { id: "month", label: "Month" },
              { id: "week", label: "Week" },
            ]}
          />

          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="tertiary"
              isIconOnly
              aria-label="Previous"
              onPress={() => setAnchor((d) => shift(d, view, -1))}
            >
              ‹
            </Button>
            <span className="min-w-40 text-center text-sm font-medium">
              {label(anchor, view)}
            </span>
            <Button
              size="sm"
              variant="tertiary"
              isIconOnly
              aria-label="Next"
              onPress={() => setAnchor((d) => shift(d, view, 1))}
            >
              ›
            </Button>
          </div>

          <Button
            size="sm"
            variant="secondary"
            onPress={() => setAnchor(startOfDay(new Date()))}
          >
            Today
          </Button>
        </div>
      </header>

      <div className="flex gap-4">
        {unscheduled.length > 0 && (
          <Card className="w-56 shrink-0">
            <Card.Header>
              <Card.Title className="text-sm">Needs a time</Card.Title>
              <Card.Description className="text-xs">
                Approved but not scheduled — drag one onto a day
              </Card.Description>
            </Card.Header>
            <Card.Content className="space-y-2">
              {unscheduled.map((post) => (
                <PostChip
                  key={post.id}
                  post={post}
                  onOpen={() => setSelected(post.id)}
                  onDragStart={() => setDragging(post.id)}
                />
              ))}
            </Card.Content>
          </Card>
        )}

        <Card className="min-w-0 flex-1">
          <Card.Content className="p-3">
            <div className="mb-1 grid grid-cols-7 gap-1.5">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => (
                <div
                  key={name}
                  className="px-1 pb-1 text-xs font-medium uppercase tracking-wide opacity-40"
                >
                  {name}
                </div>
              ))}
            </div>

            {isLoading ? (
              <div className="grid grid-cols-7 gap-1.5">
                {Array.from({ length: 35 }, (_, i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-1.5">
                {days.map((day) => {
                  const dayPosts = dated.filter((p) =>
                    sameDay(new Date(p.scheduledAt ?? p.publishedAt ?? ""), day),
                  );
                  const outside =
                    view === "month" && day.getMonth() !== anchor.getMonth();

                  return (
                    <div
                      key={day.toISOString()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => move(day)}
                      className={`rounded-lg border p-1.5 transition-colors ${
                        view === "month" ? "min-h-24" : "min-h-64"
                      } ${
                        isToday(day)
                          ? "border-warning/60 bg-warning/5"
                          : "border-default-200/60"
                      } ${outside ? "opacity-35" : ""} ${
                        dragging ? "hover:border-warning hover:bg-warning/10" : ""
                      }`}
                    >
                      <div className="mb-1 px-0.5 text-xs tabular-nums opacity-50">
                        {day.getDate()}
                      </div>
                      <div className="space-y-1">
                        {dayPosts.slice(0, view === "month" ? 3 : 12).map((post) => (
                          <PostChip
                            key={post.id}
                            post={post}
                            compact
                            onOpen={() => setSelected(post.id)}
                            onDragStart={() => setDragging(post.id)}
                          />
                        ))}
                        {view === "month" && dayPosts.length > 3 && (
                          <div className="px-1 text-xs opacity-40">
                            +{dayPosts.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card.Content>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3 text-xs opacity-50">
        {(["pending_approval", "scheduled", "published", "failed"] as const).map(
          (status) => (
            <span key={status} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${STATUS_META[status].dot}`} />
              {STATUS_META[status].label}
            </span>
          ),
        )}
      </div>

      {selected && <PostDrawer postId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PostChip({
  post,
  compact,
  onOpen,
  onDragStart,
}: {
  post: Post;
  compact?: boolean;
  onOpen: () => void;
  onDragStart: () => void;
}) {
  const meta = STATUS_META[post.status];
  return (
    <Tooltip delay={400}>
      <Tooltip.Trigger>
        <button
          type="button"
          draggable={post.status !== "published"}
          onDragStart={onDragStart}
          onClick={onOpen}
          className="w-full cursor-grab rounded-md bg-default-100/70 px-1.5 py-1 text-left text-xs transition-colors hover:bg-default-200/70 active:cursor-grabbing"
        >
          <div className="flex items-center gap-1">
            <span className={`size-1.5 shrink-0 rounded-full ${meta.dot}`} />
            <span className="truncate opacity-50">@{post.account.handle}</span>
          </div>
          <div className={compact ? "line-clamp-2" : "line-clamp-3"}>
            {post.content.text}
          </div>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-72">
        <p className="text-xs">{post.content.text}</p>
        <p className="mt-1 text-xs opacity-60">
          {meta.label}
          {post.scheduledAt && ` · ${formatDateTime(post.scheduledAt)}`}
        </p>
      </Tooltip.Content>
    </Tooltip>
  );
}

// ── Date helpers ─────────────────────────────────────────────────────────

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Weeks start on Monday, which is how a working week is planned. */
function startOfWeek(date: Date): Date {
  const copy = startOfDay(date);
  const weekday = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - weekday);
  return copy;
}

/** Six rows so the grid does not jump height between months. */
function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

function weekGrid(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

function shift(date: Date, view: View, direction: number): Date {
  const copy = new Date(date);
  if (view === "month") copy.setMonth(copy.getMonth() + direction);
  else copy.setDate(copy.getDate() + direction * 7);
  return copy;
}

function label(anchor: Date, view: View): string {
  if (view === "month") {
    return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  const start = startOfWeek(anchor);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString(
    "en-US",
    sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" },
  )}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(day: Date): boolean {
  return sameDay(day, new Date());
}
