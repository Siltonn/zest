"use client";

import { Button, Card, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api, type AnalyticsResponse, type Workspace } from "@/lib/api";
import { Sparkline } from "@/components/sparkline";
import { compactNumber, formatDateTime, percent } from "@/lib/format";

export default function DashboardPage() {
  const queryClient = useQueryClient();

  const { data: workspace } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.get<Workspace>("/workspace"),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api.get<AnalyticsResponse>("/analytics?days=30"),
  });

  const { data: inbox } = useQuery({
    queryKey: ["inbox-count"],
    queryFn: () => api.get<{ count: number }>("/inbox/count"),
  });

  const plan = useMutation({
    mutationFn: () => api.post("/agent/plan"),
    onSuccess: () =>
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["inbox"] }), 2000),
  });

  const analyze = useMutation({
    mutationFn: () => api.post("/agent/analyze", { weekly: true }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{workspace?.name ?? "Dashboard"}</h1>
          {workspace?.kpiConfig?.goal && (
            <p className="text-sm opacity-60">Goal: {workspace.kpiConfig.goal}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onPress={() => plan.mutate()}
            isPending={plan.isPending}
          >
            Run planning now
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => analyze.mutate()}
            isPending={analyze.isPending}
          >
            Weekly report
          </Button>
        </div>
      </header>

      {(inbox?.count ?? 0) > 0 && (
        <Card className="border-l-4 border-l-warning">
          <Card.Content className="flex items-center justify-between py-3">
            <span className="text-sm">
              <strong>{inbox?.count}</strong> item
              {inbox?.count === 1 ? "" : "s"} waiting for your decision
            </span>
            <Link
              href="/inbox"
              className="rounded-lg bg-default-200/70 px-3 py-1.5 text-sm font-medium hover:bg-default-300/70"
            >
              Review
            </Link>
          </Card.Content>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Impressions" value={compactNumber(s.impressions)} />
        <Stat label="Followers" value={compactNumber(s.followers)} />
        <Stat label="Engagement" value={percent(s.engagementRate)} />
        <Stat label="Published" value={String(s.postCount)} sub="last 30 days" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <Card.Header>
            <Card.Title className="text-sm">Impressions</Card.Title>
          </Card.Header>
          <Card.Content className="text-sky-500">
            <Sparkline points={data.series.impressions} />
          </Card.Content>
        </Card>
        <Card>
          <Card.Header>
            <Card.Title className="text-sm">Followers</Card.Title>
          </Card.Header>
          <Card.Content className="text-emerald-500">
            <Sparkline points={data.series.followers} />
          </Card.Content>
        </Card>
      </div>

      <Card>
        <Card.Header>
          <Card.Title className="text-sm">Best performing</Card.Title>
        </Card.Header>
        <Card.Content>
          {data.topPosts.length === 0 ? (
            <p className="py-4 text-sm opacity-50">
              Nothing published yet. Approve something from the inbox and fast-forward a
              day to see how it lands.
            </p>
          ) : (
            <ul className="divide-y divide-default-200/60">
              {data.topPosts.map((post) => (
                <li key={post.postId} className="flex gap-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{post.text}</span>
                  <span className="shrink-0 opacity-50">@{post.accountHandle}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums">
                    {compactNumber(post.impressions)}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums opacity-70">
                    {percent(post.engagementRate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>

      {workspace && (
        <p className="text-xs opacity-40">
          Pomelo time is {formatDateTime(workspace.simNow)} — the simulated clock runs
          ahead so a day of engagement plays out in seconds.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <Card.Content className="py-3">
        <div className="text-xs uppercase tracking-wide opacity-50">{label}</div>
        <div className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-xs opacity-40">{sub}</div>}
      </Card.Content>
    </Card>
  );
}
