"use client";

import { Button, Card, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Account, type AutonomyRule, type TrustStat } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type AutonomyResponse = { rules: AutonomyRule[]; trust: TrustStat[] };

const ACTIONS = [
  {
    id: "write_plan",
    label: "Write planned weeks",
    blurb:
      "Send a planned week straight to the copywriter. Without this the topics wait in your inbox first — the cheapest place to change your mind.",
  },
  {
    id: "schedule_post",
    label: "Schedule posts",
    blurb: "Publish on the proposed time without asking first.",
  },
  {
    id: "send_reply",
    label: "Send replies",
    blurb: "Answer comments directly. Usually worth limiting to positive ones.",
  },
  {
    id: "update_memory",
    label: "Update strategy",
    blurb:
      "Rewrite strategy and learnings after analysis. The brand brief and voice cards always stay under review.",
  },
] as const;

/**
 * Where trust is granted.
 *
 * The system tracks how often proposals were approved untouched and says when
 * a run is long enough to be worth acting on. Autonomy is meant to be earned
 * from evidence rather than toggled on a hunch.
 */
export default function AutonomyPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["autonomy"],
    queryFn: () => api.get<AutonomyResponse>("/autonomy"),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const grant = useMutation({
    mutationFn: (input: { action: string; connectorId?: string; mode: string }) =>
      api.post("/autonomy", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["autonomy"] }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/autonomy/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["autonomy"] }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  const platforms = [...new Set(accounts.map((a) => a.connectorId))];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Autonomy</h1>
        <p className="text-sm opacity-60">
          Every agent action starts as a proposal. Grant autonomy where the agent has
          earned it — and take it back the moment it has not.
        </p>
      </header>

      {ACTIONS.map((action) => {
        const trust = data.trust.find((t) => t.action === action.id);
        const rules = data.rules.filter((r) => r.action === action.id);

        return (
          <Card key={action.id}>
            <Card.Header>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Card.Title className="text-base">{action.label}</Card.Title>
                  <p className="mt-0.5 text-xs opacity-50">{action.blurb}</p>
                </div>
                {trust && (
                  <Chip
                    size="sm"
                    variant="soft"
                    color={trust.readyToGraduate ? "success" : "default"}
                  >
                    {trust.consecutiveCleanApprovals} in a row
                  </Chip>
                )}
              </div>
            </Card.Header>

            <Card.Content className="space-y-3">
              {trust && (
                <div className="text-sm opacity-70">
                  {trust.approved === 0 && trust.editedOrRejected === 0 ? (
                    "No review history yet."
                  ) : trust.readyToGraduate ? (
                    <>
                      Approved unchanged {trust.consecutiveCleanApprovals} times running.
                      This looks safe to hand over.
                    </>
                  ) : (
                    <>
                      {trust.approved} approved, {trust.editedOrRejected} edited or
                      rejected. Not a long enough run to hand over yet.
                    </>
                  )}
                </div>
              )}

              {rules.length > 0 && (
                <div className="space-y-1.5">
                  {rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between rounded-lg bg-default-100/60 px-3 py-2 text-sm"
                    >
                      <div>
                        <span
                          className={
                            rule.mode === "auto"
                              ? "font-medium text-emerald-600"
                              : "opacity-70"
                          }
                        >
                          {rule.mode === "auto" ? "Acts on its own" : "Asks first"}
                        </span>
                        <span className="opacity-50">
                          {rule.connectorId ? ` on ${rule.connectorId}` : " everywhere"}
                          {rule.conditions?.sentiment &&
                            ` · ${rule.conditions.sentiment} only`}
                        </span>
                        <div className="text-xs opacity-40">
                          granted {relativeTime(rule.grantedAt)}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="tertiary"
                        onPress={() => revoke.mutate(rule.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {platforms.map((platform) => {
                  const granted = rules.some(
                    (r) => r.connectorId === platform && r.mode === "auto",
                  );
                  if (granted) return null;
                  return (
                    <Button
                      key={platform}
                      size="sm"
                      variant={trust?.readyToGraduate ? "primary" : "secondary"}
                      onPress={() =>
                        grant.mutate({
                          action: action.id,
                          connectorId: platform,
                          mode: "auto",
                        })
                      }
                      isPending={grant.isPending}
                    >
                      Grant on {platform}
                    </Button>
                  );
                })}
              </div>
            </Card.Content>
          </Card>
        );
      })}
    </div>
  );
}
