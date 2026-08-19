"use client";

import { Card, Chip, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { FastForwardButton } from "@/components/fast-forward-button";
import { compactNumber, relativeTime } from "@/lib/format";

type PostDetail = {
  id: string;
  text: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  impressions: number;
  createdAt: string;
  author: {
    handle: string;
    displayName: string;
    avatarUrl: string;
    bio: string | null;
    isPersona: boolean;
  };
  replies: {
    id: string;
    text: string;
    createdAt: string;
    author: { handle: string; displayName: string; avatarUrl: string };
  }[];
};

/**
 * A single Pomelo post with its conversation.
 *
 * This is where a published post's "View on Pomelo" link lands, and where the
 * simulated audience becomes concrete: not a reply count, but people saying
 * specific things you can answer.
 */
export default function PomeloPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const { data: post, isLoading } = useQuery({
    queryKey: ["pomelo-post", id],
    queryFn: () =>
      fetch(`/api/pomelo/posts/${id}`).then((r) => {
        if (!r.ok) throw new Error("That post is not on Pomelo");
        return r.json() as Promise<PostDetail>;
      }),
    refetchInterval: 10_000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (!post) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <Card.Content className="py-12 text-center">
            <p className="opacity-60">That post is not on Pomelo.</p>
            <Link href="/pomelo" className="mt-2 inline-block text-sm underline">
              Back to the feed
            </Link>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/pomelo" className="text-sm opacity-50 hover:opacity-80">
        ← Pomelo
      </Link>

      <Card>
        <Card.Content className="space-y-4 py-4">
          <div className="flex gap-3">
            <img
              src={post.author.avatarUrl}
              alt=""
              className="size-11 shrink-0 rounded-full bg-default-200"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{post.author.displayName}</span>
                <span className="opacity-55">@{post.author.handle}</span>
                {!post.author.isPersona && (
                  <Chip size="sm" variant="soft" color="warning">
                    you
                  </Chip>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[17px] leading-relaxed">
                {post.text}
              </p>
              <div className="mt-1 text-xs opacity-55">
                {relativeTime(post.createdAt)}
              </div>
            </div>
          </div>

          <div className="flex gap-6 border-t border-default-200/60 pt-3 text-sm">
            <Metric label="seen by" value={compactNumber(post.impressions)} />
            <Metric label="likes" value={String(post.likeCount)} />
            <Metric label="reposts" value={String(post.repostCount)} />
            <Metric label="replies" value={String(post.replyCount)} />
          </div>
        </Card.Content>
      </Card>

      <div>
        <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide opacity-50">
          {post.replies.length === 0
            ? "No replies yet"
            : `${post.replies.length} repl${post.replies.length === 1 ? "y" : "ies"}`}
        </div>

        <div className="space-y-2">
          {post.replies.map((reply) => (
            <Card key={reply.id}>
              <Card.Content className="py-3">
                <div className="flex gap-3">
                  <img
                    src={reply.author.avatarUrl}
                    alt=""
                    className="size-8 shrink-0 rounded-full bg-default-200"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm">
                      <span className="font-medium">{reply.author.displayName}</span>
                      <span className="opacity-55">@{reply.author.handle}</span>
                      <span className="opacity-30">·</span>
                      <span className="opacity-55">{relativeTime(reply.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap text-[15px] leading-relaxed">
                      {reply.text}
                    </p>
                  </div>
                </div>
              </Card.Content>
            </Card>
          ))}
        </div>

        {post.replies.length === 0 && (
          <Card>
            <Card.Content className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm opacity-50">
                The audience reacts on Pomelo time — advance the clock to hear
                from them now.
              </p>
              <FastForwardButton size="sm" />
            </Card.Content>
          </Card>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-medium tabular-nums">{value}</span>{" "}
      <span className="opacity-50">{label}</span>
    </div>
  );
}
