"use client";

import { Card, Chip, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { compactNumber, relativeTime } from "@/lib/format";

type FeedPost = {
  id: string;
  text: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  impressions: number;
  createdAt: string;
  author: { handle: string; displayName: string; avatarUrl: string; isPersona: boolean };
};

type Resident = {
  handle: string;
  displayName: string;
  avatarUrl: string;
  bio: string | null;
  followerCount: number;
  personaConfig: { archetype: string; interests: string[]; tone: string } | null;
};

/**
 * Pomelo — the simulated network, shown as itself rather than as a debug view.
 *
 * Giving the fake platform its own identity is the difference between "here is
 * some test data" and "here is a place where your posts land and people react".
 * The residents panel makes the audience legible: these are the personas whose
 * interests decide whether a post travels.
 */
export default function PomeloPage() {
  const { data: feed = [], isLoading } = useQuery({
    queryKey: ["pomelo-feed"],
    queryFn: () => fetch("/api/pomelo/feed").then((r) => r.json() as Promise<FeedPost[]>),
    refetchInterval: 10_000,
  });

  const { data: residents = [] } = useQuery({
    queryKey: ["pomelo-residents"],
    queryFn: () =>
      fetch("/api/pomelo/residents").then((r) => r.json() as Promise<Resident[]>),
  });

  const { data: trends = [] } = useQuery({
    queryKey: ["pomelo-trends"],
    queryFn: () =>
      fetch("/api/pomelo/trends").then(
        (r) => r.json() as Promise<{ topic: string; momentum: number }[]>,
      ),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-center gap-3">
        <span className="text-3xl">🍊</span>
        <div>
          <h1 className="text-2xl font-semibold">Pomelo</h1>
          <p className="text-sm opacity-60">
            A social network that ships inside Zest. Its residents react to what you
            post — no API keys, no rate limits, no waiting for approval.
          </p>
        </div>
      </header>

      <div className="flex gap-6">
        <div className="min-w-0 flex-1 space-y-3">
          {isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : feed.length === 0 ? (
            <Card>
              <Card.Content className="py-12 text-center opacity-60">
                Nothing posted yet. Publish something and fast-forward a day.
              </Card.Content>
            </Card>
          ) : (
            feed.map((post) => (
              <Card key={post.id}>
                <Card.Content className="py-3">
                  <div className="flex gap-3">
                    <img
                      src={post.author.avatarUrl}
                      alt=""
                      className="size-9 shrink-0 rounded-full bg-default-200"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="font-medium">{post.author.displayName}</span>
                        <span className="opacity-40">@{post.author.handle}</span>
                        {!post.author.isPersona && (
                          <Chip size="sm" variant="soft" color="warning">
                            you
                          </Chip>
                        )}
                        <span className="opacity-30">·</span>
                        <span className="opacity-40">{relativeTime(post.createdAt)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed">
                        {post.text}
                      </p>
                      <div className="mt-2 flex gap-5 text-xs opacity-50">
                        <span>💬 {post.replyCount}</span>
                        <span>🔁 {post.repostCount}</span>
                        <span>♥ {post.likeCount}</span>
                        <span>👁 {compactNumber(post.impressions)}</span>
                      </div>
                    </div>
                  </div>
                </Card.Content>
              </Card>
            ))
          )}
        </div>

        <aside className="hidden w-64 shrink-0 space-y-4 lg:block">
          <Card>
            <Card.Header>
              <Card.Title className="text-sm">Trending</Card.Title>
            </Card.Header>
            <Card.Content className="space-y-1.5">
              {trends.map((trend) => (
                <div key={trend.topic} className="flex justify-between text-sm">
                  <span className="truncate">{trend.topic}</span>
                  <span className="shrink-0 tabular-nums opacity-40">
                    {trend.momentum}
                  </span>
                </div>
              ))}
            </Card.Content>
          </Card>

          <Card>
            <Card.Header>
              <Card.Title className="text-sm">
                Residents · {residents.length}
              </Card.Title>
            </Card.Header>
            <Card.Content className="max-h-96 space-y-2.5 overflow-y-auto">
              {residents.slice(0, 18).map((person) => (
                <div key={person.handle} className="flex gap-2">
                  <img
                    src={person.avatarUrl}
                    alt=""
                    className="size-7 shrink-0 rounded-full bg-default-200"
                  />
                  <div className="min-w-0 text-xs">
                    <div className="truncate font-medium">{person.displayName}</div>
                    <div className="truncate opacity-40">
                      {person.personaConfig?.archetype.replace(/_/g, " ")} ·{" "}
                      {compactNumber(person.followerCount)}
                    </div>
                  </div>
                </div>
              ))}
            </Card.Content>
          </Card>
        </aside>
      </div>
    </div>
  );
}
