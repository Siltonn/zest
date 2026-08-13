"use client";

import { Card, Chip, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type AgentRun } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";

const ROLES: Record<string, { label: string; blurb: string; icon: string }> = {
  researcher: {
    label: "Researcher",
    blurb: "Finds what is worth talking about",
    icon: "🔍",
  },
  strategist: {
    label: "Strategist",
    blurb: "Turns research into a weekly plan",
    icon: "🗺",
  },
  copywriter: { label: "Copywriter", blurb: "Writes the posts", icon: "✍" },
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

type TranscriptStep = {
  text?: string;
  toolCalls?: { tool: string; args: unknown }[];
  toolResults?: { tool: string; result: unknown }[];
};

/**
 * The agent team, and what each run actually did.
 *
 * Roles are prompts plus tool subsets, run in a fixed order by ordinary code.
 * Showing the transcript matters more than showing the roster: a proposal you
 * can trace back to the tools that produced it is reviewable; one you cannot is
 * just output.
 */
export default function TeamPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TeamView />
    </Suspense>
  );
}

function TeamView() {
  const params = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get("run"));

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<AgentRun[]>("/runs"),
    refetchInterval: 15_000,
  });

  const { data: run } = useQuery({
    queryKey: ["run", selected],
    queryFn: () => api.get<AgentRun>(`/runs/${selected}`),
    enabled: Boolean(selected),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="text-sm opacity-60">
          Five roles, run in sequence by the planning workflow. Not a chat between
          agents — each stage hands the next a concrete artifact.
        </p>
      </header>

      <div className="grid gap-2 md:grid-cols-5">
        {Object.entries(ROLES).map(([id, role]) => (
          <Card key={id}>
            <Card.Content className="py-3">
              <div className="text-lg">{role.icon}</div>
              <div className="mt-1 text-sm font-medium">{role.label}</div>
              <div className="text-xs opacity-50">{role.blurb}</div>
            </Card.Content>
          </Card>
        ))}
      </div>

      <div className="flex gap-4">
        <div className="w-72 shrink-0 space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide opacity-50">
            Recent runs
          </div>
          {runs.length === 0 && (
            <p className="text-sm opacity-50">
              No runs yet. Start one from the dashboard.
            </p>
          )}
          {runs.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelected(item.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                selected === item.id
                  ? "border-default-400 bg-default-100/70"
                  : "border-default-200/60 hover:bg-default-100/50"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span>{item.role ? ROLES[item.role]?.icon : "◍"}</span>
                <span className="font-medium">
                  {item.role ? ROLES[item.role]?.label : "Assistant"}
                </span>
                <Chip
                  size="sm"
                  variant="soft"
                  color={
                    item.status === "failed"
                      ? "danger"
                      : item.status === "running"
                        ? "warning"
                        : "success"
                  }
                >
                  {item.status}
                </Chip>
              </div>
              <div className="text-xs opacity-40">
                {item.trigger.replace(/_/g, " ")} · {relativeTime(item.startedAt)}
              </div>
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          {run ? (
            <Card>
              <Card.Header>
                <Card.Title className="text-base">
                  {run.role ? ROLES[run.role]?.label : "Assistant"} run
                </Card.Title>
                <p className="text-xs opacity-50">
                  {formatDateTime(run.startedAt)} · {run.model ?? "model unrecorded"} ·{" "}
                  {run.inputTokens + run.outputTokens} tokens
                </p>
              </Card.Header>
              <Card.Content className="space-y-3">
                {run.errorMessage && (
                  <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
                    {run.errorMessage}
                  </div>
                )}
                {(run.transcript as TranscriptStep[]).length === 0 ? (
                  <p className="text-sm opacity-50">No transcript recorded.</p>
                ) : (
                  (run.transcript as TranscriptStep[]).map((step, index) => (
                    <div key={index} className="space-y-1.5">
                      {step.text && (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">
                          {step.text}
                        </p>
                      )}
                      {step.toolCalls?.map((call, i) => (
                        <div
                          key={i}
                          className="rounded-lg bg-default-100/60 px-3 py-1.5 font-mono text-xs"
                        >
                          <span className="opacity-50">called</span> {call.tool}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </Card.Content>
            </Card>
          ) : (
            <Card>
              <Card.Content className="py-12 text-center text-sm opacity-50">
                Pick a run to see what it did.
              </Card.Content>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
