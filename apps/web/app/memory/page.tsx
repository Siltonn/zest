"use client";

import { Button, Card, Chip, Spinner, TextArea } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { api, type Account, type MemoryDoc } from "@/lib/api";
import { Segmented } from "@/components/segmented";
import { describeActor, relativeTime } from "@/lib/format";

type MemoryResponse = {
  brief: MemoryDoc | null;
  strategy: MemoryDoc | null;
  learnings: MemoryDoc | null;
  persona: MemoryDoc | null;
  report: MemoryDoc | null;
};

/**
 * What the agent believes.
 *
 * Plain markdown, versioned, editable. Keeping memory readable is the point:
 * when a post sounds wrong, the operator can see exactly which sentence in the
 * brief or the voice card produced it, and change that instead of arguing with
 * the model.
 */
export default function MemoryPage() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["memory", accountId],
    queryFn: () =>
      api.get<MemoryResponse>(`/memory${accountId ? `?accountId=${accountId}` : ""}`),
  });

  const save = useMutation({
    mutationFn: ({ kind, contentMd }: { kind: string; contentMd: string }) =>
      api.post("/memory", {
        kind,
        contentMd,
        ...(kind === "persona" && accountId ? { accountId } : {}),
      }),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  const docs: { kind: string; title: string; blurb: string; doc: MemoryDoc | null }[] = [
    {
      kind: "brand_brief",
      title: "Brand brief",
      blurb: "Who this brand is and what it will not say. You own this one.",
      doc: data?.brief ?? null,
    },
    {
      kind: "strategy",
      title: "Strategy",
      blurb: "The current plan and cadence. The agent proposes changes to it.",
      doc: data?.strategy ?? null,
    },
    {
      kind: "learnings",
      title: "Learnings",
      blurb: "What has actually held up across posts, written by the analyst.",
      doc: data?.learnings ?? null,
    },
  ];

  // Only shown once a weekly run has produced one.
  if (data?.report) {
    docs.push({
      kind: "report",
      title: "Latest weekly report",
      blurb: "What went out, how it did, and what the agent plans next.",
      doc: data.report,
    });
  }

  if (accountId) {
    docs.splice(1, 0, {
      kind: "persona",
      title: `Voice · @${accounts.find((a) => a.id === accountId)?.handle}`,
      blurb:
        "How this account in particular sounds. Two accounts sharing one voice is the failure mode this prevents.",
      doc: data?.persona ?? null,
    });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Memory</h1>
        <p className="text-sm opacity-60">
          Everything the agent knows about your brand, in plain markdown.
        </p>
      </header>

      <Segmented
        value={accountId ?? "workspace"}
        onChange={(value) => setAccountId(value === "workspace" ? null : value)}
        options={[
          { id: "workspace", label: "Workspace" },
          ...accounts.map((a) => ({ id: a.id, label: `@${a.handle}` })),
        ]}
        size="md"
      />

      {docs.map(({ kind, title, blurb, doc }) => (
        <Card key={kind}>
          <Card.Header className="flex flex-row items-start justify-between gap-3">
            <div>
              <Card.Title className="text-base">{title}</Card.Title>
              <p className="mt-0.5 text-xs opacity-50">{blurb}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {doc && (
                <Chip size="sm" variant="soft">
                  v{doc.version}
                </Chip>
              )}
              {editing === kind ? (
                <>
                  <Button
                    size="sm"
                    onPress={() => save.mutate({ kind, contentMd: draft })}
                    isPending={save.isPending}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="tertiary" onPress={() => setEditing(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setEditing(kind);
                    setDraft(doc?.contentMd ?? "");
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
          </Card.Header>

          <Card.Content>
            {editing === kind ? (
              <TextArea
                value={draft}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
                rows={16}
                className="font-mono text-sm"
                autoFocus
              />
            ) : doc ? (
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed opacity-85">
                {doc.contentMd}
              </pre>
            ) : (
              <p className="py-3 text-sm opacity-50">
                Not written yet. Ask the agent in chat, or write it here.
              </p>
            )}
          </Card.Content>

          {doc && (
            <Card.Footer className="text-xs opacity-40">
              Last changed by {describeActor(doc.updatedByActor)} ·{" "}
              {relativeTime(doc.createdAt)}
            </Card.Footer>
          )}
        </Card>
      ))}
    </div>
  );
}
