"use client";

import Link from "next/link";

import {
  Button,
  Card,
  Chip,
  ListBox,
  ListBoxItem,
  Select,
  Spinner,
} from "@heroui/react";
import { Segmented } from "@/components/segmented";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AuditEntry } from "@/lib/api";
import { actorBadge, describeActor, relativeTime } from "@/lib/format";

type AuditPage = {
  entries: AuditEntry[];
  nextCursor: string | null;
  breakdown: Record<string, number>;
  entityTypes: string[];
};

const ACTORS = [
  { id: "all", label: "Everything" },
  { id: "human", label: "You" },
  { id: "agent", label: "Agent" },
  { id: "system", label: "Scheduler" },
  { id: "mcp", label: "MCP" },
  { id: "api", label: "API" },
];

/**
 * Provenance.
 *
 * Written inside the same transaction as every state change, so this is a
 * complete record rather than a best-effort log. It answers the question that
 * decides whether anyone can trust an autonomous system: who actually did this?
 *
 * Which makes it the one page guaranteed to grow forever, and it was rendering
 * a flat 200-row table. Three things fix that, in order of how much they help:
 * day headings, so you can see *when* without reading timestamps; a filter on
 * what changed, which the API already supported and the UI never sent; and
 * cursor paging, because an append-only log read backwards shifts under an
 * offset the moment anything happens.
 */
export default function AuditPage() {
  const [actorKind, setActorKind] = useState("all");
  const [entityType, setEntityType] = useState("all");

  const query = (cursor?: string) => {
    const params = new URLSearchParams();
    if (actorKind !== "all") params.set("actorKind", actorKind);
    if (entityType !== "all") params.set("entityType", entityType);
    if (cursor) params.set("before", cursor);
    const qs = params.toString();
    return `/audit${qs ? `?${qs}` : ""}`;
  };

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["audit", actorKind, entityType],
      queryFn: ({ pageParam }) => api.get<AuditPage>(query(pageParam)),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    });

  const first = data?.pages[0];
  const entries = data?.pages.flatMap((page) => page.entries) ?? [];

  if (isLoading || !first) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  // Grouped as you read: newest day first, entries already in order.
  const days: { day: string; entries: AuditEntry[] }[] = [];
  for (const entry of entries) {
    const day = new Date(entry.createdAt).toDateString();
    const current = days.at(-1);
    if (current?.day === day) current.entries.push(entry);
    else days.push({ day, entries: [entry] });
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
        {Object.entries(first.breakdown).map(([kind, count]) => (
          <div key={kind} className="rounded-lg bg-default-100/60 px-3 py-1.5 text-sm">
            <span className="capitalize opacity-60">{kind}</span>{" "}
            <span className="font-medium tabular-nums">{count}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={actorKind}
          onChange={setActorKind}
          options={ACTORS}
          label="Filter by who acted"
        />

        {/* The API always accepted this; only the UI never asked. */}
        <Select
          selectedKey={entityType}
          onSelectionChange={(key) => setEntityType(String(key))}
          className="w-44"
          aria-label="Filter by what changed"
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {[
                <ListBoxItem key="all" id="all" textValue="Anything">
                  Anything
                </ListBoxItem>,
                ...first.entityTypes.map((type) => (
                  <ListBoxItem key={type} id={type} textValue={type}>
                    {type.replace(/_/g, " ")}
                  </ListBoxItem>
                )),
              ]}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {entries.length === 0 ? (
        <Card>
          <Card.Content className="py-12 text-center text-sm opacity-55">
            Nothing matches that filter.
          </Card.Content>
        </Card>
      ) : (
        <div className="space-y-4">
          {days.map(({ day, entries: dayEntries }) => (
            <section key={day}>
              <h2 className="sticky top-0 z-10 mb-1.5 bg-[var(--background)]/90 py-1 text-xs font-medium uppercase tracking-wide opacity-55 backdrop-blur">
                {formatDay(day)}
                <span className="ml-2 font-normal normal-case tabular-nums opacity-70">
                  {dayEntries.length}
                </span>
              </h2>

              <Card>
                <Card.Content className="p-0">
                  <ul className="divide-y divide-default-200/50">
                    {dayEntries.map((entry) => (
                      <AuditRow key={entry.id} entry={entry} />
                    ))}
                  </ul>
                </Card.Content>
              </Card>
            </section>
          ))}

          {hasNextPage && (
            <div className="flex justify-center pt-1">
              <Button
                variant="secondary"
                onPress={() => void fetchNextPage()}
                isPending={isFetchingNextPage}
              >
                Load older
              </Button>
            </div>
          )}
          {!hasNextPage && (
            <p className="pt-1 text-center text-xs opacity-55">
              That is the whole history.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One event as a sentence rather than a row of columns.
 *
 * A table made you assemble "who / what / when" from three cells; the actual
 * unit here is one short statement, and the timestamp only matters relative to
 * the day heading above it.
 */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const badge = actorBadge(entry.actor);

  return (
    <li className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-default-100/40">
      <span
        className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs ${badge.color}`}
      >
        {badge.label}
      </span>

      <div className="min-w-0 flex-1 text-sm">
        <span className="capitalize">{entry.action.replace(/_/g, " ")}</span>{" "}
        <Chip size="sm" variant="soft">
          {entry.entityType.replace(/_/g, " ")}
        </Chip>
        {entry.toStatus && (
          <span className="opacity-55"> → {entry.toStatus.replace(/_/g, " ")}</span>
        )}
        <div className="mt-0.5 text-xs opacity-55">
          {describeActor(entry.actor)}
          {entry.agentRunId && (
            <>
              {" · "}
              <Link
                href={`/team?run=${entry.agentRunId}`}
                className="underline hover:opacity-80"
              >
                see the run
              </Link>
            </>
          )}
        </div>
      </div>

      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums opacity-55">
        {relativeTime(entry.createdAt)}
      </span>
    </li>
  );
}

function formatDay(day: string): string {
  const date = new Date(day);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}
