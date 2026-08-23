"use client";

import {
  Button,
  Card,
  Chip,
  Disclosure,
  Kbd,
  Spinner,
  TextArea,
  toast,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ChangeEvent } from "react";
import { api, type InboxItem } from "@/lib/api";
import { DiffView } from "@/components/diff";
import { Unanswered } from "@/components/unanswered";
import Link from "next/link";
import { relativeTime, formatDateTime } from "@/lib/format";

/**
 * Where a decision on this item is sent. Posts and replies are domain rows;
 * memory rewrites and autonomy requests are change requests, and approving one
 * rewrites a document or grants a rule rather than scheduling anything.
 */
function endpointFor(item: InboxItem, action: string): string {
  if (item.kind === "reply") return `/replies/${item.id}/${action}`;
  if (item.kind === "post") return `/posts/${item.id}/${action}`;
  if (item.kind === "plan") return `/plans/${item.id}/${action}`;
  return `/changes/${item.id}/${action}`;
}

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  post: "post",
  reply: "reply",
  memory: "memory",
  autonomy_request: "autonomy",
  plan: "plan",
};

const KIND_COLOR: Record<
  InboxItem["kind"],
  "warning" | "accent" | "success" | "default"
> = {
  post: "warning",
  reply: "accent",
  memory: "accent",
  autonomy_request: "success",
  plan: "default",
};

/**
 * The approval inbox — where graduated autonomy is actually operated.
 *
 * Every proposal shows the agent's reasoning, because approving something you
 * do not understand is not oversight. Keyboard-first (j/k to move, a/e/r to
 * act) since reviewing a week of content should take a minute, not ten.
 */
export default function InboxPage() {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api.get<InboxItem[]>("/inbox"),
  });

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ capabilities?: { llm: boolean } }>("/me"),
  });
  const canThink = me?.capabilities?.llm ?? true;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
    void queryClient.invalidateQueries({ queryKey: ["posts"] });
  };

  const approve = useMutation({
    mutationFn: ({ item, text }: { item: InboxItem; text?: string }) =>
      api.post(endpointFor(item, "approve"), text ? { text } : {}),
    onSuccess: () => {
      setEditing(null);
      refresh();
      // Approving a change request rewrites memory or grants a rule.
      void queryClient.invalidateQueries({ queryKey: ["memory"] });
      void queryClient.invalidateQueries({ queryKey: ["autonomy"] });
    },
  });

  const reject = useMutation({
    mutationFn: (item: InboxItem) => api.post(endpointFor(item, "reject")),
    onSuccess: refresh,
  });

  const requestChanges = useMutation({
    mutationFn: ({ item, note }: { item: InboxItem; note: string }) =>
      api.post<{ reworking: boolean; note?: string }>(
        `/posts/${item.id}/request-changes`,
        { feedback: note },
      ),
    onSuccess: (result) => {
      setFeedback(null);
      refresh();
      // Saying which of the two happened matters: one of them means walking
      // away, the other means it is now your turn to edit.
      toast.success(
        result.reworking ? "Sent back for a rewrite" : "Sent back",
        {
          description:
            result.note ?? "The copywriter is revising it against your note.",
        },
      );
      setTimeout(refresh, 6000);
    },
    onError: (error: Error) =>
      toast.danger("Could not send it back", { description: error.message }),
  });

  const active = items[cursor];

  useEffect(() => {
    // Keeps the cursor on a real row after approving the last item. React
    // would rather this were clamped during render than corrected in an
    // effect; that is a worthwhile change, but it moves where the keyboard
    // handlers read the cursor from, so it is not a lint fix.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cursor >= items.length && items.length > 0) setCursor(items.length - 1);
  }, [items.length, cursor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never steal keys while someone is typing an edit or feedback.
      const target = event.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
      if (!active) return;

      if (event.key === "j") setCursor((c) => Math.min(c + 1, items.length - 1));
      if (event.key === "k") setCursor((c) => Math.max(c - 1, 0));
      if (event.key === "a") approve.mutate({ item: active });
      if (event.key === "r") reject.mutate(active);
      if (event.key === "e" && (active.kind === "post" || active.kind === "reply")) {
        setEditing(active.id);
        setDraft(active.body);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, items.length, approve, reject]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="text-sm opacity-60">
            {items.length === 0
              ? "Nothing waiting on you."
              : `${items.length} item${items.length === 1 ? "" : "s"} waiting on you`}
          </p>
        </div>
        {items.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs opacity-50">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            <span>move</span>
            <Kbd>a</Kbd>
            <span>approve</span>
            <Kbd>e</Kbd>
            <span>edit</span>
            <Kbd>r</Kbd>
            <span>reject</span>
          </div>
        )}
      </header>

      <div className="mb-3">
        <Unanswered canThink={canThink} />
      </div>

      {items.length === 0 ? (
        <Card>
          <Card.Content className="py-12 text-center">
            <div className="mb-2 text-3xl">✓</div>
            <p className="opacity-60">
              The agent has nothing pending. Run a planning cycle from the dashboard to
              get proposals.
            </p>
          </Card.Content>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => {
            const isActive = index === cursor;
            return (
              <Card
                key={item.id}
                className={`transition-shadow ${isActive ? "ring-2 ring-warning" : ""}`}
                onClick={() => setCursor(index)}
              >
                <Card.Header className="flex flex-row items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Card.Title className="text-base">{item.title}</Card.Title>
                    <div className="mt-0.5 flex items-center gap-2 text-xs opacity-50">
                      <span>{relativeTime(item.createdAt)}</span>
                      {item.suggestedSlotAt && (
                        <span>· suggested {formatDateTime(item.suggestedSlotAt)}</span>
                      )}
                    </div>
                  </div>
                  <Chip size="sm" variant="soft" color={KIND_COLOR[item.kind]}>
                    {KIND_LABEL[item.kind]}
                  </Chip>
                </Card.Header>

                <Card.Content className="space-y-3">
                  {/* What the agent is replying to, so the draft can be judged. */}
                  {item.context && (
                    <div className="rounded-lg border-l-2 border-default-300 bg-default-100/50 px-3 py-2 text-sm">
                      <div className="text-xs opacity-50">
                        @{item.context.author}
                        {item.context.sentiment && ` · ${item.context.sentiment}`}
                      </div>
                      <div className="mt-0.5 opacity-80">{item.context.text}</div>
                    </div>
                  )}

                  {editing === item.id ? (
                    <TextArea
                      value={draft}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
                      rows={5}
                      autoFocus
                    />
                  ) : item.kind === "memory" ? (
                    <DiffView before={item.before ?? ""} after={item.body} />
                  ) : item.kind === "plan" ? (
                    <PlanItems item={item} onChanged={refresh} />
                  ) : item.kind === "autonomy_request" ? (
                    <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2.5 text-sm">
                      <p className="leading-relaxed">{item.body}</p>
                      <p className="mt-1.5 text-xs opacity-60">
                        Approving grants a standing rule. The agent keeps using the same
                        tools — they stop asking first. You can revoke it any time on the
                        autonomy page.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
                        {item.body}
                      </p>
                      {(item.threadParts ?? []).map((part, index) => (
                        <p
                          key={index}
                          className="ml-3 whitespace-pre-wrap border-l-2 border-default-200 pl-3 text-sm leading-relaxed opacity-80"
                        >
                          {part}
                        </p>
                      ))}
                    </>
                  )}

                  {item.reasoning && (
                    <Disclosure className="text-sm">
                      <Disclosure.Heading>
                        <Disclosure.Trigger className="opacity-60 hover:opacity-100">
                          {item.kind === "autonomy_request"
                            ? "Why it thinks it has earned this"
                            : "Why the agent proposed this"}
                          <Disclosure.Indicator />
                        </Disclosure.Trigger>
                      </Disclosure.Heading>
                      <Disclosure.Content>
                        <Disclosure.Body>
                          <p className="opacity-70">{item.reasoning}</p>
                          {item.agentRunId && (
                            <Link
                              href={`/team?run=${item.agentRunId}`}
                              className="mt-1 inline-block text-xs underline opacity-50"
                            >
                              See the full run
                            </Link>
                          )}
                        </Disclosure.Body>
                      </Disclosure.Content>
                    </Disclosure>
                  )}

                  {feedback !== null && isActive && (
                    <TextArea
                      placeholder="What should change? The agent will rewrite it."
                      value={feedback}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setFeedback(e.target.value)}
                      rows={2}
                      autoFocus
                    />
                  )}
                </Card.Content>

                <Card.Footer className="flex flex-wrap gap-2">
                  {editing === item.id ? (
                    <>
                      <Button
                        size="sm"
                        onPress={() => approve.mutate({ item, text: draft })}
                        isPending={approve.isPending}
                      >
                        Save and approve
                      </Button>
                      <Button size="sm" variant="tertiary" onPress={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : feedback !== null && isActive ? (
                    <>
                      <Button
                        size="sm"
                        onPress={() => requestChanges.mutate({ item, note: feedback })}
                        isPending={requestChanges.isPending}
                        isDisabled={feedback.trim().length === 0}
                      >
                        Send back
                      </Button>
                      <Button size="sm" variant="tertiary" onPress={() => setFeedback(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        onPress={() => approve.mutate({ item })}
                        isPending={approve.isPending}
                      >
                        Approve
                      </Button>
                      {item.kind === "plan" && (
                        <Link href="/plans">
                          <Button size="sm" variant="secondary">
                            Open in plans
                          </Button>
                        </Link>
                      )}
                      {(item.kind === "post" || item.kind === "reply") && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onPress={() => {
                            setEditing(item.id);
                            setDraft(item.body);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                      {item.kind === "post" && (
                        <Button
                          size="sm"
                          variant="tertiary"
                          onPress={() => {
                            setCursor(index);
                            setFeedback("");
                          }}
                        >
                          Ask for changes
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="tertiary"
                        onPress={() => reject.mutate(item)}
                        isPending={reject.isPending}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                </Card.Footer>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A planned week, as topics rather than drafts.
 *
 * Approving releases the whole thing to the writers; dropping a topic here
 * costs one click and saves the model call that would have turned it into a
 * draft nobody wanted. That is the entire argument for this altitude existing.
 */
function PlanItems({
  item,
  onChanged,
}: {
  item: InboxItem;
  onChanged: () => void;
}) {
  const [dropped, setDropped] = useState<Set<string>>(new Set());

  const skip = useMutation({
    mutationFn: (itemId: string) => api.post(`/plans/items/${itemId}/skip`),
    onSuccess: (_result, itemId) => {
      setDropped((current) => new Set(current).add(itemId));
      onChanged();
    },
  });

  const items = item.planItems ?? [];
  const byAccount = new Map<string, typeof items>();
  for (const entry of items) {
    byAccount.set(entry.accountHandle, [
      ...(byAccount.get(entry.accountHandle) ?? []),
      entry,
    ]);
  }

  return (
    <div className="space-y-3">
      {item.body && <p className="text-sm opacity-60">{item.body}</p>}
      {[...byAccount.entries()].map(([handle, entries]) => (
        <div key={handle}>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide opacity-55">
            @{handle}
          </div>
          <div className="space-y-1">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`flex items-start justify-between gap-3 rounded-lg border border-default-200/60 px-3 py-2 ${
                  dropped.has(entry.id) ? "opacity-55 line-through" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{entry.topic}</div>
                  {entry.angle && (
                    <div className="text-xs opacity-60">{entry.angle}</div>
                  )}
                  {entry.suggestedSlotAt && (
                    <div className="mt-0.5 text-xs opacity-55">
                      {formatDateTime(entry.suggestedSlotAt)}
                    </div>
                  )}
                </div>
                {!dropped.has(entry.id) && (
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => skip.mutate(entry.id)}
                    isPending={skip.isPending}
                  >
                    Drop
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
