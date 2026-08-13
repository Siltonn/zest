"use client";

import {
  Avatar,
  Card,
  Chip,
  EmptyState,
  Separator,
  Skeleton,
  Tooltip,
} from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import NextLink from "next/link";
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
 * Pomelo — the simulated network, presented as itself rather than as a debug
 * view. Every post opens its own conversation, because the audience only feels
 * real once you can read what individual people said.
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
    <div className="mx-auto max-w-none">
      <header className="mb-6 flex items-center gap-3">
        <span className="text-3xl">🍊</span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pomelo</h1>
          <p className="text-sm opacity-60">
            A social network that ships inside Zest. Its residents react to what you
            post — no API keys, no rate limits, no waiting for approval.
          </p>
        </div>
      </header>

      <div className="flex gap-6">
        <div className="min-w-0 flex-1 space-y-3">
          {isLoading ? (
            <>
              {[0, 1, 2].map((i) => (
                <Card key={i}>
                  <Card.Content className="flex gap-3 py-4">
                    <Skeleton className="size-10 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  </Card.Content>
                </Card>
              ))}
            </>
          ) : feed.length === 0 ? (
            <EmptyState>
              <div className="py-10 text-center">
                <div className="text-3xl">🍊</div>
                <p className="mt-2 font-medium">Nothing posted yet</p>
                <p className="mt-1 text-sm opacity-60">
                  Publish something, then fast-forward a day to watch it land.
                </p>
              </div>
            </EmptyState>
          ) : (
            feed.map((post) => (
              // The whole card is the link: a feed where only the timestamp is
              // clickable is a feed people think is broken.
              <NextLink
                key={post.id}
                href={`/pomelo/post/${post.id}`}
                className="block rounded-xl outline-none transition-transform focus-visible:ring-2 focus-visible:ring-warning active:scale-[0.998]"
              >
                <Card className="hover:bg-default-100/40">
                  <Card.Content className="py-4">
                    <div className="flex gap-3">
                      <Avatar className="size-10 shrink-0">
                        <Avatar.Image src={post.author.avatarUrl} alt="" />
                        <Avatar.Fallback>
                          {post.author.displayName.slice(0, 2)}
                        </Avatar.Fallback>
                      </Avatar>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
                          <span className="font-medium">{post.author.displayName}</span>
                          <span className="opacity-40">@{post.author.handle}</span>
                          {!post.author.isPersona && (
                            <Chip size="sm" variant="soft" color="warning">
                              you
                            </Chip>
                          )}
                          <span className="opacity-30">·</span>
                          <span className="opacity-40">
                            {relativeTime(post.createdAt)}
                          </span>
                        </div>

                        <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed">
                          {post.text}
                        </p>

                        <div className="mt-3 flex gap-6 text-xs opacity-50">
                          <Stat icon="💬" value={post.replyCount} label="replies" />
                          <Stat icon="🔁" value={post.repostCount} label="reposts" />
                          <Stat icon="♥" value={post.likeCount} label="likes" />
                          <Stat icon="👁" value={post.impressions} label="saw this" />
                        </div>
                      </div>
                    </div>
                  </Card.Content>
                </Card>
              </NextLink>
            ))
          )}
        </div>

        <aside className="hidden w-72 shrink-0 space-y-4 lg:block">
          <Card>
            <Card.Header>
              <Card.Title className="text-sm">Trending</Card.Title>
              <Card.Description className="text-xs">
                What the agent researches before it plans
              </Card.Description>
            </Card.Header>
            <Card.Content className="space-y-2.5">
              {trends.map((trend) => (
                <div key={trend.topic}>
                  <div className="flex justify-between text-sm">
                    <span className="truncate">{trend.topic}</span>
                    <span className="shrink-0 tabular-nums opacity-40">
                      {trend.momentum}
                    </span>
                  </div>
                  {/* Momentum as a bar reads faster than a bare number. */}
                  <div className="mt-1 h-1 rounded-full bg-default-200/60">
                    <div
                      className="h-1 rounded-full bg-warning"
                      style={{ width: `${trend.momentum}%` }}
                    />
                  </div>
                </div>
              ))}
            </Card.Content>
          </Card>

          <Card>
            <Card.Header>
              <Card.Title className="text-sm">Residents · {residents.length}</Card.Title>
              <Card.Description className="text-xs">
                Their interests decide how far a post travels
              </Card.Description>
            </Card.Header>
            <Card.Content className="max-h-[26rem] space-y-3 overflow-y-auto">
              {residents.map((person, index) => (
                <div key={person.handle}>
                  {index > 0 && <Separator className="mb-3 opacity-40" />}
                  <Tooltip>
                    <Tooltip.Trigger>
                      <div className="flex cursor-help gap-2.5 text-left">
                        <Avatar className="size-8 shrink-0">
                          <Avatar.Image src={person.avatarUrl} alt="" />
                          <Avatar.Fallback>
                            {person.displayName.slice(0, 2)}
                          </Avatar.Fallback>
                        </Avatar>
                        <div className="min-w-0 text-xs">
                          <div className="truncate font-medium">{person.displayName}</div>
                          <div className="truncate opacity-40">
                            {person.personaConfig?.archetype.replace(/_/g, " ")} ·{" "}
                            {compactNumber(person.followerCount)} followers
                          </div>
                        </div>
                      </div>
                    </Tooltip.Trigger>
                    <Tooltip.Content className="max-w-56">
                      <p className="text-xs">{person.bio}</p>
                      {person.personaConfig && (
                        <p className="mt-1 text-xs opacity-60">
                          Interested in {person.personaConfig.interests.slice(0, 3).join(", ")}
                        </p>
                      )}
                    </Tooltip.Content>
                  </Tooltip>
                </div>
              ))}
            </Card.Content>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/**
 * Plain markup, not a Tooltip: a tooltip trigger renders a button, and a button
 * inside the card's link is both invalid HTML and enough to swallow the click.
 */
function Stat({
  icon,
  value,
  label,
}: {
  icon: string;
  value: number;
  label: string;
}) {
  return (
    <span className="tabular-nums" title={`${value} ${label}`}>
      {icon} {compactNumber(value)}
    </span>
  );
}
