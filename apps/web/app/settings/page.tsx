"use client";

import { Button, Card, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Workspace } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type NotificationTarget = {
  id: string;
  kind: "email" | "slack" | "discord";
  config: { email?: string; webhookUrl?: string };
  digestMode: "instant" | "daily";
};

type ApiKey = { id: string; name: string; lastUsedAt: string | null; key?: string };

const SCHEDULES = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays only" },
  { id: "weekly", label: "Once a week" },
];

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [target, setTarget] = useState({ kind: "slack", value: "" });

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.get<Workspace>("/workspace"),
  });

  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationTarget[]>("/notifications"),
  });

  const { data: keys = [] } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<ApiKey[]>("/api-keys"),
  });

  const update = useMutation({
    mutationFn: (patch: Partial<Workspace>) => api.post("/workspace", patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace"] }),
  });

  const addTarget = useMutation({
    mutationFn: () =>
      api.post("/notifications", {
        kind: target.kind,
        config:
          target.kind === "email"
            ? { email: target.value }
            : { webhookUrl: target.value },
      }),
    onSuccess: () => {
      setTarget({ kind: "slack", value: "" });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const removeTarget = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const createKey = useMutation({
    mutationFn: () => api.post<ApiKey>("/api-keys", { name: "MCP client" }),
    onSuccess: (created) => {
      setNewKey(created.key ?? null);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Planning schedule</Card.Title>
          <p className="text-xs opacity-50">
            How often the agent researches and proposes a batch of content.
          </p>
        </Card.Header>
        <Card.Content className="flex flex-wrap gap-2">
          {SCHEDULES.map((option) => (
            <button
              key={option.id}
              onClick={() => update.mutate({ planningSchedule: option.id })}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                workspace?.planningSchedule === option.id
                  ? "bg-default-200/80 font-medium"
                  : "hover:bg-default-100"
              }`}
            >
              {option.label}
            </button>
          ))}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Where to reach you</Card.Title>
          <p className="text-xs opacity-50">
            An agent that proposes work is useless if nobody hears about it.
          </p>
        </Card.Header>
        <Card.Content className="space-y-3">
          {notifications.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-lg bg-default-100/60 px-3 py-2 text-sm"
            >
              <div>
                <Chip size="sm" variant="soft">
                  {item.kind}
                </Chip>{" "}
                <span className="opacity-70">
                  {item.config.email ?? item.config.webhookUrl}
                </span>
              </div>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => removeTarget.mutate(item.id)}
              >
                Remove
              </Button>
            </div>
          ))}

          <div className="flex gap-2">
            <select
              value={target.kind}
              onChange={(e) => setTarget((t) => ({ ...t, kind: e.target.value }))}
              className="rounded-lg border border-default-200/60 bg-transparent px-2 py-2 text-sm"
            >
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="email">Email</option>
            </select>
            <input
              value={target.value}
              onChange={(e) => setTarget((t) => ({ ...t, value: e.target.value }))}
              placeholder={
                target.kind === "email" ? "you@example.com" : "webhook URL"
              }
              className="flex-1 rounded-lg border border-default-200/60 bg-transparent px-3 py-2 text-sm"
            />
            <Button
              size="sm"
              onPress={() => addTarget.mutate()}
              isDisabled={!target.value}
            >
              Add
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">API keys</Card.Title>
          <p className="text-xs opacity-50">
            How Claude Desktop and other agents connect over MCP. Point them at{" "}
            <code>/mcp</code> on this instance.
          </p>
        </Card.Header>
        <Card.Content className="space-y-3">
          {newKey && (
            <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm">
              <div className="font-medium text-emerald-700">
                Copy this now — it is not shown again.
              </div>
              <code className="mt-1 block break-all text-xs">{newKey}</code>
            </div>
          )}
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between text-sm opacity-70"
            >
              <span>{key.name}</span>
              <span className="text-xs opacity-60">
                {key.lastUsedAt ? `used ${relativeTime(key.lastUsedAt)}` : "never used"}
              </span>
            </div>
          ))}
          <Button size="sm" variant="secondary" onPress={() => createKey.mutate()}>
            Create a key
          </Button>
        </Card.Content>
      </Card>
    </div>
  );
}
