"use client";

import Link from "next/link";

import { Card, Chip, Spinner, Table } from "@heroui/react";
import { Segmented } from "@/components/segmented";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AuditEntry } from "@/lib/api";
import { actorBadge, describeActor, formatDateTime, relativeTime } from "@/lib/format";

type AuditResponse = { entries: AuditEntry[]; breakdown: Record<string, number> };

const FILTERS = [
  { id: undefined, label: "Everything" },
  { id: "human", label: "You" },
  { id: "agent", label: "Agent" },
  { id: "system", label: "Scheduler" },
  { id: "mcp", label: "MCP" },
  { id: "api", label: "API" },
] as const;

/**
 * Provenance.
 *
 * Written inside the same transaction as every state change, so this is a
 * complete record rather than a best-effort log. It answers the question that
 * decides whether anyone can trust an autonomous system: who actually did this?
 */
export default function AuditPage() {
  const [actorKind, setActorKind] = useState<string | undefined>();

  const { data, isLoading } = useQuery({
    queryKey: ["audit", actorKind],
    queryFn: () =>
      api.get<AuditResponse>(`/audit${actorKind ? `?actorKind=${actorKind}` : ""}`),
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="text-sm opacity-60">
          Every change, and who caused it. Nothing moves through Zest without landing
          here.
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        {Object.entries(data.breakdown).map(([kind, count]) => (
          <div key={kind} className="rounded-lg bg-default-100/60 px-3 py-1.5 text-sm">
            <span className="capitalize opacity-60">{kind}</span>{" "}
            <span className="font-medium tabular-nums">{count}</span>
          </div>
        ))}
      </div>

      <Segmented
        value={actorKind ?? "all"}
        onChange={(value) => setActorKind(value === "all" ? undefined : value)}
        options={FILTERS.map((f) => ({ id: f.id ?? "all", label: f.label }))}
      />

      <Card>
        <Card.Content className="p-0">
          {data.entries.length === 0 ? (
            <p className="py-10 text-center text-sm opacity-50">Nothing recorded yet.</p>
          ) : (
            <Table>
              {/* Table root is a styled wrapper; Content is the real table, and
                  the collection parts have to live inside it. */}
              <Table.Content aria-label="Audit log">
              <Table.Header>
                <Table.Column isRowHeader>Actor</Table.Column>
                <Table.Column>What happened</Table.Column>
                <Table.Column>When</Table.Column>
              </Table.Header>
              <Table.Body>
                {data.entries.map((entry) => {
                  const badge = actorBadge(entry.actor);
                  return (
                    <Table.Row key={entry.id}>
                      <Table.Cell>
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${badge.color}`}
                        >
                          {badge.label}
                        </span>
                        <div className="mt-0.5 text-xs opacity-45">
                          {describeActor(entry.actor)}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="capitalize">
                          {entry.action.replace(/_/g, " ")}
                        </span>{" "}
                        <span className="opacity-50">
                          {entry.entityType.replace(/_/g, " ")}
                        </span>
                        {entry.toStatus && (
                          <span className="opacity-50">
                            {" "}
                            → {entry.toStatus.replace(/_/g, " ")}
                          </span>
                        )}
                        {entry.agentRunId && (
                          <>
                            {" · "}
                            {/* Every agent action is one click from the
                                transcript that produced it. */}
                            <Link
                              href={`/team?run=${entry.agentRunId}`}
                              className="text-xs underline opacity-50"
                            >
                              run
                            </Link>
                          </>
                        )}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-xs opacity-45">
                        {formatDateTime(entry.createdAt)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
              </Table.Content>
            </Table>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
