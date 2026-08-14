"use client";

import { Alert, Button, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Post } from "@/lib/api";
import {
  STATUS_META,
  actorBadge,
  describeActor,
  formatDateTime,
  relativeTime,
} from "@/lib/format";

/**
 * One post, in full.
 *
 * The timeline is the point: every state change with who caused it and when,
 * so "why did this go out?" always has an answer — and an agent-driven change
 * links back to the run that produced it.
 */
export function PostDrawer({
  postId,
  onClose,
}: {
  postId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: post, isLoading } = useQuery({
    queryKey: ["post", postId],
    queryFn: () => api.get<Post>(`/posts/${postId}`),
  });

  const act = useMutation({
    mutationFn: (action: string) => api.post(`/posts/${postId}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["post", postId] });
      void queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-y-auto border-l border-default-200/60 bg-[var(--background)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {isLoading || !post ? (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${STATUS_META[post.status].dot}`} />
                  <span className="text-sm font-medium">
                    {STATUS_META[post.status].label}
                  </span>
                </div>
                <div className="mt-0.5 text-xs opacity-50">
                  @{post.account.handle} on {post.account.connectorId}
                </div>
              </div>
              <Button size="sm" variant="tertiary" onPress={onClose}>
                Close
              </Button>
            </div>

            <p className="whitespace-pre-wrap rounded-xl border border-default-200/60 p-4 text-[15px] leading-relaxed">
              {post.content.text}
            </p>

            {(post.content.thread ?? []).map((part, index) => (
              <p
                key={index}
                className="ml-4 mt-2 whitespace-pre-wrap rounded-xl border border-default-200/60 border-l-2 border-l-default-300 p-3 text-sm leading-relaxed"
              >
                <span className="mb-1 block text-xs opacity-45">
                  Part {index + 2} · published as a reply
                </span>
                {part}
              </p>
            ))}

            {post.recycledFromId && (
              <p className="mt-2 text-xs opacity-50">
                ♻ Evergreen re-run of an earlier post — the reasoning below carries
                its numbers.
              </p>
            )}

            {post.errorMessage && (
              <Alert status="danger" className="mt-3">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Publishing failed</Alert.Title>
                  <Alert.Description>{post.errorMessage}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}

            {post.reasoning && (
              <div className="mt-3 text-sm">
                <div className="text-xs uppercase tracking-wide opacity-50">
                  Agent's reasoning
                </div>
                <p className="mt-1 opacity-80">{post.reasoning}</p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {post.status === "scheduled" && (
                <>
                  <Button size="sm" onPress={() => act.mutate("publish-now")}>
                    Publish now
                  </Button>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => act.mutate("cancel")}
                  >
                    Cancel
                  </Button>
                </>
              )}
              {post.status === "failed" && (
                <Button size="sm" onPress={() => act.mutate("retry")}>
                  Retry
                </Button>
              )}
              {post.externalUrl && (
                <a
                  href={post.externalUrl}
                  className="rounded-lg bg-default-200/70 px-3 py-1.5 text-sm hover:bg-default-300/70"
                >
                  View on {post.account.connectorId}
                </a>
              )}
            </div>

            <div className="mt-6">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide opacity-50">
                History
              </div>
              <ol className="space-y-2.5">
                {(post.timeline ?? []).map((entry) => {
                  const badge = actorBadge(entry.actor);
                  return (
                    <li key={entry.id} className="flex gap-3 text-sm">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-default-400" />
                      <div className="min-w-0">
                        <div>
                          <span className="capitalize">
                            {entry.action.replace(/_/g, " ")}
                          </span>{" "}
                          <span className="opacity-60">
                            by {describeActor(entry.actor)}
                          </span>
                          <span
                            className={`ml-1.5 rounded px-1.5 py-0.5 text-xs ${badge.color}`}
                          >
                            {badge.label}
                          </span>
                        </div>
                        <div className="text-xs opacity-40">
                          {relativeTime(entry.createdAt)} ·{" "}
                          {formatDateTime(entry.createdAt)}
                        </div>
                        {entry.agentRunId && (
                          <a
                            href={`/team?run=${entry.agentRunId}`}
                            className="text-xs underline opacity-50"
                          >
                            see the run
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
