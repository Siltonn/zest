"use client";

import { Chip, Spinner } from "@heroui/react";
import type { Account, AgentRun } from "@/lib/api";
import { relativeTime } from "@/lib/format";

/**
 * One planning cycle, drawn as the pipeline it actually is.
 *
 * The stages run as separate jobs — research once, a strategist per plan, a
 * writer per account — which is the whole architectural claim and was
 * completely unreadable as a flat list of runs. Drawing the fan-out makes two
 * things obvious at a glance that prose cannot: research happens once and is
 * shared, and each writer sees exactly one account.
 */

export const ROLE_META: Record<
  string,
  { label: string; blurb: string; icon: string }
> = {
  researcher: {
    label: "Researcher",
    blurb: "Finds what is worth talking about",
    icon: "🔍",
  },
  strategist: {
    label: "Strategist",
    blurb: "Turns research into a plan, per programme",
    icon: "🗺",
  },
  copywriter: { label: "Copywriter", blurb: "Writes for one account", icon: "✍" },
  community: {
    label: "Community manager",
    blurb: "Triages replies and drafts responses",
    icon: "💬",
  },
  analyst: {
    label: "Analyst",
    blurb: "Reviews performance and updates what we learned",
    icon: "📊",
  },
};

export type Cycle = { id: string; runs: AgentRun[]; startedAt: string };

/** Groups runs into cycles, newest first. Anything unlinked is its own row. */
export function groupIntoCycles(runs: AgentRun[]): Cycle[] {
  const cycles = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const key = run.cycleId ?? run.id;
    cycles.set(key, [...(cycles.get(key) ?? []), run]);
  }

  return [...cycles.entries()]
    .map(([id, group]) => ({
      id,
      runs: group.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      startedAt: group.reduce(
        (earliest, r) => (r.startedAt < earliest ? r.startedAt : earliest),
        group[0]!.startedAt,
      ),
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function statusColor(status: string): "danger" | "warning" | "success" | "default" {
  if (status === "failed") return "danger";
  if (status === "running") return "warning";
  if (status === "succeeded") return "success";
  return "default";
}

export function CyclePipeline({
  cycle,
  accounts,
  selectedRunId,
  onSelect,
}: {
  cycle: Cycle;
  accounts: Account[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const stages = [
    { role: "researcher", runs: cycle.runs.filter((r) => r.role === "researcher") },
    { role: "strategist", runs: cycle.runs.filter((r) => r.role === "strategist") },
    { role: "copywriter", runs: cycle.runs.filter((r) => r.role === "copywriter") },
  ].filter((stage) => stage.runs.length > 0);

  // Triage, analysis and chat are single runs with no fan-out to draw.
  const loose = cycle.runs.filter(
    (r) => !["researcher", "strategist", "copywriter"].includes(r.role ?? ""),
  );

  if (stages.length === 0) {
    return (
      <div className="space-y-1.5">
        {loose.map((run) => (
          <RunChip
            key={run.id}
            run={run}
            accounts={accounts}
            isSelected={run.id === selectedRunId}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {stages.map((stage, index) => (
        <div key={stage.role}>
          <div className="mb-1 flex items-center gap-1.5 text-xs opacity-45">
            <span>{ROLE_META[stage.role]?.icon}</span>
            <span className="font-medium">{ROLE_META[stage.role]?.label}</span>
            {/* The count is the point of the drawing: one research, many writers. */}
            {stage.runs.length > 1 && <span>× {stage.runs.length}</span>}
          </div>
          <div
            className={`space-y-1 ${index > 0 ? "border-l border-default-200/60 pl-3" : ""}`}
          >
            {stage.runs.map((run) => (
              <RunChip
                key={run.id}
                run={run}
                accounts={accounts}
                isSelected={run.id === selectedRunId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ))}
      {loose.length > 0 && (
        <div className="space-y-1 pt-1">
          {loose.map((run) => (
            <RunChip
              key={run.id}
              run={run}
              accounts={accounts}
              isSelected={run.id === selectedRunId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunChip({
  run,
  accounts,
  isSelected,
  onSelect,
}: {
  run: AgentRun;
  accounts: Account[];
  isSelected: boolean;
  onSelect: (runId: string) => void;
}) {
  const handle = run.accountId
    ? accounts.find((a) => a.id === run.accountId)?.handle
    : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={`w-full rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
        isSelected
          ? "border-default-400 bg-default-100/70"
          : "border-default-200/60 hover:bg-default-100/50"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {run.status === "running" && <Spinner className="size-3" />}
        <span className="truncate font-medium">
          {handle ? `@${handle}` : (ROLE_META[run.role ?? ""]?.label ?? "Assistant")}
        </span>
        <Chip size="sm" variant="soft" color={statusColor(run.status)}>
          {run.status}
        </Chip>
      </div>
      <div className="text-xs opacity-40">
        {run.trigger.replace(/_/g, " ")} · {relativeTime(run.startedAt)}
      </div>
    </button>
  );
}
