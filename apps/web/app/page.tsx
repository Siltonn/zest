"use client";

import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  Separator,
  Skeleton,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  api,
  type Account,
  type AnalyticsResponse,
  type MemoryDoc,
  type Post,
  type Workspace,
} from "@/lib/api";
import { Segmented } from "@/components/segmented";
import { Sparkline } from "@/components/sparkline";
import {
  STATUS_META,
  compactNumber,
  formatDateTime,
  percent,
  relativeTime,
} from "@/lib/format";

const WINDOWS = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState("30");

  const { data: workspace } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.get<Workspace>("/workspace"),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => api.get<AnalyticsResponse>(`/analytics?days=${days}`),
  });

  const { data: inbox } = useQuery({
    queryKey: ["inbox-count"],
    queryFn: () => api.get<{ count: number }>("/inbox/count"),
  });

  const { data: posts = [] } = useQuery({
    queryKey: ["posts"],
    queryFn: () => api.get<Post[]>("/posts"),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const { data: memory } = useQuery({
    queryKey: ["memory", null],
    queryFn: () => api.get<{ report: MemoryDoc | null }>("/memory"),
  });

  const plan = useMutation({
    mutationFn: () => api.post("/agent/plan"),
    onSuccess: () =>
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["inbox"] }), 2000),
  });

  const analyze = useMutation({
    mutationFn: () => api.post("/agent/analyze", { weekly: true }),
    onSuccess: () =>
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["memory"] }), 3000),
  });

  const upcoming = posts
    .filter((p) => p.status === "scheduled" && p.scheduledAt)
    .sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""))
    .slice(0, 5);

  const recent = posts.filter((p) => p.status === "published").slice(0, 5);
  const summary = data?.summary;

  return (
    <div className="mx-auto max-w-none space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {workspace?.name ?? "Dashboard"}
          </h1>
          {workspace?.kpiConfig?.goal && (
            <p className="mt-1 text-sm opacity-60">{workspace.kpiConfig.goal}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={days} onChange={setDays} options={WINDOWS} />
          <Button onPress={() => plan.mutate()} isPending={plan.isPending}>
            Run planning
          </Button>
          <Button
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
          <Card.Content className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div>
              <div className="font-medium">
                {inbox?.count} item{inbox?.count === 1 ? "" : "s"} waiting on you
              </div>
              <div className="text-sm opacity-60">
                The agent has proposed work and paused for your decision.
              </div>
            </div>
            <Link href="/inbox">
              <Button size="sm">Review now</Button>
            </Link>
          </Card.Content>
        </Card>
      )}

      {/* Headline numbers, sized to be read across a room. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Impressions"
          value={summary ? compactNumber(summary.impressions) : null}
          hint={`across ${summary?.postCount ?? 0} posts`}
        />
        <Stat
          label="Followers"
          value={summary ? compactNumber(summary.followers) : null}
          hint="all connected accounts"
        />
        <Stat
          label="Engagement"
          value={summary ? percent(summary.engagementRate) : null}
          hint={
            summary
              ? `${summary.likes + summary.reposts + summary.replies} interactions`
              : ""
          }
        />
        <Stat
          label="Published"
          value={summary ? String(summary.postCount) : null}
          hint={`last ${days} days`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Card.Header>
            <Card.Title>Reach over time</Card.Title>
            <Card.Description>
              Impressions and follower growth across the window
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-5">
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="opacity-50">Impressions</span>
                <span className="tabular-nums opacity-70">
                  {summary ? compactNumber(summary.impressions) : "—"}
                </span>
              </div>
              <div className="text-sky-500">
                <Sparkline points={data?.series.impressions ?? []} height={72} />
              </div>
            </div>
            <Separator className="opacity-40" />
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="opacity-50">Followers</span>
                <span className="tabular-nums opacity-70">
                  {summary ? compactNumber(summary.followers) : "—"}
                </span>
              </div>
              <div className="text-emerald-500">
                <Sparkline points={data?.series.followers ?? []} height={72} />
              </div>
            </div>
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Accounts</Card.Title>
            <Card.Description>Each with its own voice</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            {accounts.length === 0 ? (
              <p className="text-sm opacity-50">
                Nothing connected yet.{" "}
                <Link href="/accounts" className="underline">
                  Connect Pomelo
                </Link>{" "}
                — it takes one click.
              </p>
            ) : (
              accounts.map((account) => (
                <div key={account.id} className="flex items-center gap-3">
                  <Avatar className="size-9 shrink-0">
                    <Avatar.Image src={account.avatarUrl ?? undefined} alt="" />
                    <Avatar.Fallback>{account.handle.slice(0, 2)}</Avatar.Fallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      @{account.handle}
                    </div>
                    <div className="text-xs opacity-50">
                      {account.platform?.name ?? account.connectorId}
                    </div>
                  </div>
                  <span className="text-lg">{account.platform?.icon}</span>
                </div>
              ))
            )}
          </Card.Content>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Card.Header>
            <Card.Title>Going out next</Card.Title>
            <Card.Description>Approved and scheduled</Card.Description>
          </Card.Header>
          <Card.Content className="p-0">
            {upcoming.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm opacity-50">
                Nothing scheduled. Run a planning cycle to fill the week.
              </p>
            ) : (
              <ul className="divide-y divide-default-200/60">
                {upcoming.map((post) => (
                  <li key={post.id} className="flex gap-3 px-6 py-3">
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${STATUS_META[post.status].dot}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{post.content.text}</p>
                      <p className="text-xs opacity-40">
                        @{post.account.handle} ·{" "}
                        {post.scheduledAt ? relativeTime(post.scheduledAt) : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
          <Card.Footer>
            <Link href="/calendar" className="text-sm underline opacity-60">
              Open the calendar
            </Link>
          </Card.Footer>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Best performing</Card.Title>
            <Card.Description>By engagement rate</Card.Description>
          </Card.Header>
          <Card.Content className="p-0">
            {isLoading ? (
              <div className="space-y-3 px-6 py-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : (data?.topPosts.length ?? 0) === 0 ? (
              <p className="px-6 py-8 text-center text-sm opacity-50">
                Nothing published yet. Approve something and fast-forward a day.
              </p>
            ) : (
              <ul className="divide-y divide-default-200/60">
                {data?.topPosts.map((post) => (
                  <li key={post.postId} className="px-6 py-3">
                    <p className="truncate text-sm">{post.text}</p>
                    <div className="mt-0.5 flex gap-3 text-xs opacity-50">
                      <span>@{post.accountHandle}</span>
                      <span className="tabular-nums">
                        {compactNumber(post.impressions)} seen
                      </span>
                      <span className="tabular-nums">
                        {percent(post.engagementRate)} engaged
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      </div>

      {memory?.report && (
        <Card>
          <Card.Header>
            <div className="flex items-center gap-2">
              <Card.Title>This week, from the analyst</Card.Title>
              <Chip size="sm" variant="soft">
                v{memory.report.version}
              </Chip>
            </div>
            <Card.Description>
              Written {relativeTime(memory.report.createdAt)}
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed opacity-85">
              {memory.report.contentMd}
            </pre>
          </Card.Content>
        </Card>
      )}

      {workspace && (
        <p className="text-xs opacity-40">
          Pomelo time is {formatDateTime(workspace.simNow)}. The simulated clock runs
          ahead so a day of engagement plays out in seconds.
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  return (
    <Card>
      <Card.Content className="py-5">
        <div className="text-xs uppercase tracking-wide opacity-50">{label}</div>
        {value === null ? (
          <Skeleton className="mt-2 h-9 w-24" />
        ) : (
          <div className="mt-1 text-4xl font-semibold tabular-nums tracking-tight">
            {value}
          </div>
        )}
        {hint && <div className="mt-1 text-xs opacity-40">{hint}</div>}
      </Card.Content>
    </Card>
  );
}
