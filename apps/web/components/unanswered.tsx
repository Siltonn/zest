"use client";

import { Button, Card, Chip, TextArea, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";

/**
 * Comments nobody has answered yet.
 *
 * The agent normally drafts these, and its drafts appear in the inbox above.
 * But anything it skipped — or everything, when no model is configured — used
 * to exist only in the database. An audience reply that reaches nobody is the
 * worst failure this product can have, so the raw items are shown too, with a
 * box to answer by hand.
 */

type InboundItem = {
  id: string;
  kind: string;
  authorHandle: string;
  text: string;
  sentiment: string | null;
  receivedAt: string;
  account: { handle: string; connectorId: string };
};

const SENTIMENT_COLOR: Record<string, "success" | "warning" | "danger" | "default"> = {
  positive: "success",
  neutral: "default",
  negative: "warning",
  hostile: "danger",
};

export function Unanswered({ canThink }: { canThink: boolean }) {
  const queryClient = useQueryClient();
  const [replying, setReplying] = useState<string | null>(null);
  const [text, setText] = useState("");

  const { data: items = [] } = useQuery({
    queryKey: ["inbound"],
    queryFn: () => api.get<InboundItem[]>("/inbound"),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbound"] });
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
  };

  const triage = useMutation({
    mutationFn: () => api.post("/agent/triage"),
    onSuccess: () => {
      toast.success("Reading the comments", {
        description: "Drafted replies will appear above for your approval.",
      });
      setTimeout(refresh, 4000);
    },
    onError: (error: Error) =>
      toast.danger("Cannot triage", { description: error.message }),
  });

  const reply = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api.post(`/inbound/${id}/reply`, { text: body }),
    onSuccess: () => {
      setReplying(null);
      setText("");
      toast.success("Reply sent");
      refresh();
    },
    onError: (error: Error) =>
      toast.danger("Could not send", { description: error.message }),
  });

  const ignore = useMutation({
    mutationFn: (id: string) => api.post(`/inbound/${id}/ignore`),
    onSuccess: refresh,
  });

  if (items.length === 0) return null;

  return (
    <Card className="border-l-4 border-l-accent">
      <Card.Header className="flex flex-row items-start justify-between gap-4">
        <div>
          <Card.Title className="text-base">
            {items.length} unanswered {items.length === 1 ? "comment" : "comments"}
          </Card.Title>
          <Card.Description>
            {canThink
              ? "The agent has not read these yet. Triage drafts a reply for each, or answer one yourself."
              : "No model is configured, so nothing will be drafted automatically — you can still answer by hand."}
          </Card.Description>
        </div>
        {canThink && (
          <Button size="sm" onPress={() => triage.mutate()} isPending={triage.isPending}>
            Draft replies
          </Button>
        )}
      </Card.Header>

      <Card.Content className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-xl border border-default-200/60 px-3 py-2.5"
          >
            <div className="flex items-center gap-2 text-xs opacity-55">
              <span className="font-medium">@{item.authorHandle}</span>
              <span>· {item.kind}</span>
              <span>· on @{item.account.handle}</span>
              <span>· {relativeTime(item.receivedAt)}</span>
              {item.sentiment && (
                <Chip
                  size="sm"
                  variant="soft"
                  color={SENTIMENT_COLOR[item.sentiment] ?? "default"}
                >
                  {item.sentiment}
                </Chip>
              )}
            </div>
            <p className="mt-1 text-sm leading-relaxed">{item.text}</p>

            {replying === item.id ? (
              <div className="mt-2 space-y-2">
                <TextArea
                  value={text}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                    setText(e.target.value)
                  }
                  rows={2}
                  placeholder={`Reply to @${item.authorHandle}…`}
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onPress={() => reply.mutate({ id: item.id, body: text })}
                    isPending={reply.isPending}
                    isDisabled={!text.trim()}
                  >
                    Send reply
                  </Button>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => {
                      setReplying(null);
                      setText("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setReplying(item.id);
                    setText("");
                  }}
                >
                  Reply
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() => ignore.mutate(item.id)}
                  isPending={ignore.isPending}
                >
                  Ignore
                </Button>
              </div>
            )}
          </div>
        ))}
      </Card.Content>
    </Card>
  );
}
