"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/**
 * Live updates.
 *
 * Work happens in the worker, so without this the UI would be a series of
 * stale snapshots. Each domain event invalidates the queries it affects, which
 * is why the feed fills in and the charts move during a fast-forward instead of
 * the user wondering whether anything happened.
 */

export type DomainEvent =
  | { type: "ping" }
  | { type: "inbox.new"; itemKind: string; entityId: string; summary: string }
  | { type: "post.status_changed"; postId: string; from: string; to: string }
  | { type: "sim.event"; postId: string; kind: string; actorHandle?: string; text?: string }
  | { type: "metric.updated"; accountId: string }
  | { type: "run.progress"; runId: string; phase: string; detail?: string; role?: string }
  | { type: "clock.advanced"; simNow: string };

export type Activity = { id: number; label: string; at: number };

export function useLiveEvents(): {
  connected: boolean;
  activity: Activity[];
  lastRun: { phase: string; detail?: string; role?: string } | null;
} {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [lastRun, setLastRun] = useState<{
    phase: string;
    detail?: string;
    role?: string;
  } | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    const source = new EventSource("/events", { withCredentials: true });

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (message) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(message.data) as DomainEvent;
      } catch {
        return;
      }

      const note = (label: string) => {
        counter.current += 1;
        const entry = { id: counter.current, label, at: Date.now() };
        // Keep a short tail: this is a live ticker, not a log.
        setActivity((current) => [entry, ...current].slice(0, 30));
      };

      switch (event.type) {
        case "inbox.new":
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
          void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
          note(event.summary);
          break;

        case "post.status_changed":
          void queryClient.invalidateQueries({ queryKey: ["posts"] });
          void queryClient.invalidateQueries({ queryKey: ["post", event.postId] });
          note(`Post ${event.to.replace("_", " ")}`);
          break;

        case "sim.event":
          void queryClient.invalidateQueries({ queryKey: ["pomelo-feed"] });
          if (event.kind === "reply" && event.actorHandle) {
            note(`@${event.actorHandle} replied`);
          } else if (event.kind === "follow" && event.actorHandle) {
            note(`@${event.actorHandle} followed you`);
          }
          break;

        case "metric.updated":
          void queryClient.invalidateQueries({ queryKey: ["analytics"] });
          break;

        case "run.progress":
          setLastRun({ phase: event.phase, detail: event.detail, role: event.role });
          if (event.phase === "done" || event.phase === "failed") {
            void queryClient.invalidateQueries({ queryKey: ["inbox"] });
            void queryClient.invalidateQueries({ queryKey: ["runs"] });
            setTimeout(() => setLastRun(null), 4000);
          }
          break;

        case "clock.advanced":
          void queryClient.invalidateQueries({ queryKey: ["workspace"] });
          void queryClient.invalidateQueries({ queryKey: ["analytics"] });
          break;
      }
    };

    return () => source.close();
  }, [queryClient]);

  return { connected, activity, lastRun };
}
