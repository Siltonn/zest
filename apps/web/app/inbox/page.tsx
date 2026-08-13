"use client";

import { Button, Card, Chip, Spinner, TextArea } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ChangeEvent } from "react";
import { api, type InboxItem } from "@/lib/api";
import { relativeTime, formatDateTime } from "@/lib/format";

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

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
    void queryClient.invalidateQueries({ queryKey: ["posts"] });
  };

  const approve = useMutation({
    mutationFn: ({ item, text }: { item: InboxItem; text?: string }) =>
      api.post(
        item.kind === "reply"
          ? `/replies/${item.id}/approve`
          : `/posts/${item.id}/approve`,
        text ? { text } : {},
      ),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  const reject = useMutation({
    mutationFn: (item: InboxItem) =>
      api.post(
        item.kind === "reply" ? `/replies/${item.id}/reject` : `/posts/${item.id}/reject`,
      ),
    onSuccess: refresh,
  });

  const requestChanges = useMutation({
    mutationFn: ({ item, note }: { item: InboxItem; note: string }) =>
      api.post(`/posts/${item.id}/request-changes`, { feedback: note }),
    onSuccess: () => {
      setFeedback(null);
      refresh();
    },
  });

  const active = items[cursor];

  useEffect(() => {
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
      if (event.key === "e") {
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
          <div className="text-xs opacity-40">
            <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> approve · <kbd>e</kbd> edit ·{" "}
            <kbd>r</kbd> reject
          </div>
        )}
      </header>

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
                  <Chip
                    size="sm"
                    variant="soft"
                    color={item.kind === "reply" ? "accent" : "warning"}
                  >
                    {item.kind}
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
                  ) : (
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
                      {item.body}
                    </p>
                  )}

                  {item.reasoning && (
                    <details className="text-sm">
                      <summary className="cursor-pointer opacity-50 hover:opacity-80">
                        Why the agent proposed this
                      </summary>
                      <p className="mt-1.5 opacity-70">{item.reasoning}</p>
                      {item.agentRunId && (
                        <a
                          href={`/team?run=${item.agentRunId}`}
                          className="mt-1 inline-block text-xs underline opacity-50"
                        >
                          See the full run
                        </a>
                      )}
                    </details>
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
