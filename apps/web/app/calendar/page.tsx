"use client";

import { Button, Card, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Post } from "@/lib/api";
import { PostDrawer } from "@/components/post-drawer";
import { STATUS_META, formatDateTime } from "@/lib/format";

/**
 * The queue and the week ahead.
 *
 * Approved-but-unscheduled posts sit in a holding column; everything with a
 * time lands on a day. Dragging a card to another day reschedules it through
 * the state machine, so the move is audited like any other transition.
 */
export default function CalendarPage() {
  const queryClient = useQueryClient();
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

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  const days = nextDays(7);
  const unscheduled = posts.filter(
    (p) => p.status === "approved" && !p.scheduledAt,
  );
  const dated = posts.filter((p) => p.scheduledAt || p.publishedAt);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <p className="text-sm opacity-60">
          Drag a post to another day to move it. Everything here is already approved.
        </p>
      </header>

      <div className="flex gap-4">
        {unscheduled.length > 0 && (
          <div className="w-56 shrink-0">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide opacity-50">
              Approved · no time yet
            </div>
            <div className="space-y-2">
              {unscheduled.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  onOpen={() => setSelected(post.id)}
                  onDragStart={() => setDragging(post.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="grid min-w-0 flex-1 grid-cols-7 gap-2">
          {days.map((day) => {
            const dayPosts = dated.filter((p) =>
              sameDay(new Date(p.scheduledAt ?? p.publishedAt ?? ""), day),
            );
            return (
              <div
                key={day.toISOString()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragging) return;
                  // Keep the original time of day; only the date changes.
                  const post = posts.find((p) => p.id === dragging);
                  const previous = post?.scheduledAt
                    ? new Date(post.scheduledAt)
                    : new Date();
                  const when = new Date(day);
                  when.setHours(previous.getHours(), previous.getMinutes(), 0, 0);
                  reschedule.mutate({ id: dragging, when });
                  setDragging(null);
                }}
                className="min-h-56 rounded-xl border border-default-200/60 p-2"
              >
                <div className="mb-2 px-0.5">
                  <div className="text-xs font-medium">
                    {day.toLocaleDateString("en-US", { weekday: "short" })}
                  </div>
                  <div className="text-xs opacity-40">
                    {day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </div>
                <div className="space-y-1.5">
                  {dayPosts.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      compact
                      onOpen={() => setSelected(post.id)}
                      onDragStart={() => setDragging(post.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <PostDrawer postId={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function PostCard({
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
    <button
      draggable={post.status !== "published"}
      onDragStart={onDragStart}
      onClick={onOpen}
      className="w-full rounded-lg border border-default-200/60 bg-default-50/50 p-2 text-left text-xs transition-colors hover:bg-default-100/70"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${meta.dot}`} />
        <span className="truncate opacity-50">@{post.account.handle}</span>
      </div>
      <div className={compact ? "line-clamp-3" : "line-clamp-4"}>{post.content.text}</div>
      {post.scheduledAt && !compact && (
        <div className="mt-1 opacity-40">{formatDateTime(post.scheduledAt)}</div>
      )}
    </button>
  );
}

function nextDays(count: number): Date[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
