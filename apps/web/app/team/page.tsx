"use client";

import { Alert, Card, Chip, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type Account, type AgentRun } from "@/lib/api";
import {
  CyclePipeline,
  ROLE_META,
  groupIntoCycles,
} from "@/components/cycle-pipeline";
import { useLiveEvents } from "@/lib/events";
import { formatDateTime, relativeTime } from "@/lib/format";

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

  const { lastRun } = useLiveEvents();

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<AgentRun[]>("/runs"),
    // Poll quickly only while something is actually running; a cycle that takes
    // minutes should not look frozen, and an idle page should not busy-loop.
    refetchInterval: lastRun ? 3_000 : 30_000,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
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
          Five roles, run as separate jobs. Not a chat between agents — research
          happens once for the workspace, a strategist plans each programme, and a
          writer takes one account at a time so the voices stay apart.
        </p>
      </header>

      <div className="grid gap-2 md:grid-cols-5">
        {Object.entries(ROLE_META).map(([id, role]) => (
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
        <div className="w-72 shrink-0 space-y-3">
          <div className="text-xs font-medium uppercase tracking-wide opacity-50">
            Recent cycles
          </div>
          {runs.length === 0 && (
            <p className="text-sm opacity-50">
              No runs yet. Start one from a plan.
            </p>
          )}
          {groupIntoCycles(runs).map((cycle) => (
            <div
              key={cycle.id}
              className="rounded-xl border border-default-200/50 p-2"
            >
              <CyclePipeline
                cycle={cycle}
                accounts={accounts}
                selectedRunId={selected}
                onSelect={setSelected}
              />
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          {run ? (
            <Card>
              <Card.Header>
                <Card.Title className="text-base">
                  {run.role ? ROLE_META[run.role]?.label : "Assistant"} run
                </Card.Title>
                <p className="text-xs opacity-50">
                  {formatDateTime(run.startedAt)} · {run.model ?? "model unrecorded"} ·{" "}
                  {run.inputTokens + run.outputTokens} tokens
                </p>
              </Card.Header>
              <Card.Content className="space-y-3">
                {run.errorMessage && (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>This stage failed</Alert.Title>
                      <Alert.Description>{run.errorMessage}</Alert.Description>
                    </Alert.Content>
                  </Alert>
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
