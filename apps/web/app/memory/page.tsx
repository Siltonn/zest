"use client";

import { Button, Card, Chip, Spinner, TextArea } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { api, type Account, type MemoryDoc } from "@/lib/api";
import { DiffView } from "@/components/diff";
import { AccountSwitcher } from "@/components/account-switcher";
import { describeActor, relativeTime } from "@/lib/format";

type MemoryResponse = {
  brief: MemoryDoc | null;
  strategy: MemoryDoc | null;
  learnings: MemoryDoc | null;
  persona: MemoryDoc | null;
  accountLearnings: MemoryDoc | null;
  report: MemoryDoc | null;
};

/**
 * What the agent believes.
 *
 * Plain markdown, versioned, editable. Keeping memory readable is the point:
 * when a post sounds wrong, the operator can see exactly which sentence in the
 * brief or the playbook produced it, and change that instead of arguing with
 * the model.
 *
 * Two views, matching the two layers: the workspace tab holds the brand's
 * shared truth (brief, matrix strategy, cross-account learnings), and each
 * account tab holds that account's playbook and what the analyst has learned
 * about it specifically. One document per account on purpose.
 */
export default function MemoryPage() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
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
    mutationFn: ({
      kind,
      contentMd,
      forAccount,
    }: {
      kind: string;
      contentMd: string;
      forAccount: string | null;
    }) =>
      api.post("/memory", {
        kind,
        contentMd,
        ...(forAccount ? { accountId: forAccount } : {}),
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

  type DocEntry = {
    kind: string;
    title: string;
    blurb: string;
    doc: MemoryDoc | null;
    /** Which account the document belongs to; null = workspace-wide. */
    forAccount: string | null;
  };

  const handle = accounts.find((a) => a.id === accountId)?.handle;

  const docs: DocEntry[] = accountId
    ? [
        {
          kind: "persona",
          title: `Playbook · @${handle}`,
          blurb:
            "This account's handbook: persona, positioning, content pillars, red lines, cadence notes. Two accounts sharing one voice is the failure mode this prevents.",
          doc: data?.persona ?? null,
          forAccount: accountId,
        },
        {
          kind: "learnings",
          title: `What works here · @${handle}`,
          blurb:
            "Patterns the analyst is confident about for this account in particular — things that would not survive being posted from a different handle.",
          doc: data?.accountLearnings ?? null,
          forAccount: accountId,
        },
      ]
    : [
        {
          kind: "brand_brief",
          title: "Brand brief",
          blurb: "Who this brand is and what it will not say. You own this one.",
          doc: data?.brief ?? null,
          forAccount: null,
        },
        {
          kind: "strategy",
          title: "Strategy",
          blurb:
            "How the accounts divide the work, and the current global plan. The agent proposes changes to it.",
          doc: data?.strategy ?? null,
          forAccount: null,
        },
        {
          kind: "learnings",
          title: "Learnings",
          blurb: "What has held up whichever account posts, written by the analyst.",
          doc: data?.learnings ?? null,
          forAccount: null,
        },
      ];

  // Only shown once a weekly run has produced one.
  if (!accountId && data?.report) {
    docs.push({
      kind: "report",
      title: "Latest weekly report",
      blurb: "What went out, how it did, and what the agent plans next.",
      doc: data.report,
      forAccount: null,
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

      <AccountSwitcher
        value={accountId}
        onChange={setAccountId}
        workspaceLabel="Workspace memory"
      />

      {docs.map(({ kind, title, blurb, doc, forAccount }) => (
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
              {doc && doc.version > 1 && editing !== kind && (
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() => setHistory(history === kind ? null : kind)}
                >
                  {history === kind ? "Hide history" : "History"}
                </Button>
              )}
              {editing === kind ? (
                <>
                  <Button
                    size="sm"
                    onPress={() => save.mutate({ kind, contentMd: draft, forAccount })}
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

          {history === kind && (
            <Card.Content className="border-b border-default-200/60 pb-4">
              <MemoryHistory kind={kind} accountId={forAccount} />
            </Card.Content>
          )}

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
            <Card.Footer className="text-xs opacity-55">
              Last changed by {describeActor(doc.updatedByActor)} ·{" "}
              {relativeTime(doc.createdAt)}
            </Card.Footer>
          )}
        </Card>
      ))}
    </div>
  );
}

/**
 * How a document got to where it is.
 *
 * Memory is the thing the agent proposes changes to, so "what changed and who
 * changed it" is not a nice-to-have — approving a rewrite you cannot see the
 * shape of is the failure this whole review surface exists to prevent.
 */
function MemoryHistory({
  kind,
  accountId,
}: {
  kind: string;
  accountId: string | null;
}) {
  const { data: versions = [], isLoading } = useQuery({
    queryKey: ["memory-history", kind, accountId],
    queryFn: () =>
      api.get<MemoryDoc[]>(
        `/memory/${kind}/history${accountId ? `?accountId=${accountId}` : ""}`,
      ),
  });

  if (isLoading) return <Spinner />;
  if (versions.length < 2) {
    return <p className="text-sm opacity-50">Only one version so far.</p>;
  }

  // Newest first, each shown against the version it replaced.
  return (
    <div className="space-y-4">
      {versions.slice(0, -1).map((version, index) => {
        const previous = versions[index + 1];
        return (
          <div key={version.id}>
            <div className="mb-1.5 flex items-center gap-2 text-xs opacity-55">
              <span className="font-medium">
                v{previous?.version} → v{version.version}
              </span>
              <span>· {describeActor(version.updatedByActor)}</span>
              <span>· {relativeTime(version.createdAt)}</span>
            </div>
            <DiffView before={previous?.contentMd ?? ""} after={version.contentMd} />
          </div>
        );
      })}
    </div>
  );
}
