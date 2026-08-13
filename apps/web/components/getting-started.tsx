"use client";

import { Button, Card, ProgressBar } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api, type OnboardingState } from "@/lib/api";
import { CheckIcon } from "@/components/icons";

/**
 * The first five minutes.
 *
 * An empty workspace is the hardest screen in an agent product: everything
 * works and nothing has happened, and the reason the agent has not proposed
 * anything (it does not know whose voice to write in yet) is invisible. This
 * lays out the path in order and reads real state, so a step ticks off when the
 * work is actually done — and comes back if the account is disconnected later.
 */
export function GettingStarted() {
  const { data } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingState>("/onboarding"),
    // Cheap, and it should react as soon as a step is finished elsewhere.
    staleTime: 5_000,
  });

  if (!data || data.complete) return null;

  const next = data.steps.find((step) => !step.done);

  return (
    <Card className="border-l-4 border-l-accent">
      <Card.Header className="flex flex-row items-start justify-between gap-4">
        <div>
          <Card.Title className="text-base">Get the loop running</Card.Title>
          <Card.Description>
            Six steps from an empty workspace to the agent publishing and learning.
            No API keys needed — Pomelo is built in.
          </Card.Description>
        </div>
        <div className="hidden w-40 shrink-0 sm:block">
          <ProgressBar
            value={(data.doneCount / data.steps.length) * 100}
            aria-label="Setup progress"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <div className="mt-1 text-right text-xs opacity-50">
            {data.doneCount} of {data.steps.length}
          </div>
        </div>
      </Card.Header>

      <Card.Content className="space-y-1">
        {data.steps.map((step, index) => {
          const isNext = step.id === next?.id;
          return (
            <div
              key={step.id}
              className={`flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                isNext ? "bg-accent/5" : ""
              }`}
            >
              <div
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
                  step.done
                    ? "bg-success text-white"
                    : isNext
                      ? "bg-accent text-white"
                      : "border border-default-300 opacity-50"
                }`}
              >
                {step.done ? <CheckIcon className="size-3" /> : index + 1}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-medium ${
                    step.done ? "opacity-45 line-through" : ""
                  }`}
                >
                  {step.title}
                </div>
                {/* Only the step you are on needs explaining. */}
                {isNext && (
                  <p className="mt-0.5 text-sm opacity-60">{step.description}</p>
                )}
              </div>

              {isNext && (
                <Link href={step.href} className="shrink-0">
                  <Button size="sm">{step.cta}</Button>
                </Link>
              )}
            </div>
          );
        })}
      </Card.Content>
    </Card>
  );
}
