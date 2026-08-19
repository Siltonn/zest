"use client";

import Link from "next/link";

import {
  Button,
  Card,
  Chip,
  ListBox,
  ListBoxItem,
  Select,
  Spinner,
  toast,
} from "@heroui/react";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
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

type Webhook = {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  isActive: string;
  secretHint?: string;
  /** Only present in the create response — the one time it is ever returned. */
  secret?: string;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  consecutiveFailures: number;
};

const SCHEDULES = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays only" },
  { id: "weekly", label: "Once a week" },
];

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [target, setTarget] = useState({ kind: "slack", value: "" });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.get<Workspace>("/workspace"),
  });

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api.get<{
        capabilities?: {
          llm: boolean;
          provider?: string;
          model?: string | null;
          cheapModel?: string | null;
          recall?:
            | { enabled: true; model: string }
            | { enabled: false; reason: string };
        };
      }>("/me"),
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      // A rename shows up in the sidebar switcher too.
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
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

  const { data: webhooks = [] } = useQuery({
    queryKey: ["webhooks"],
    queryFn: () => api.get<Webhook[]>("/webhooks"),
  });

  const addWebhook = useMutation({
    mutationFn: () => api.post<Webhook>("/webhooks", { url: webhookUrl }),
    onSuccess: (created) => {
      setWebhookUrl("");
      setNewSecret(created.secret ?? null);
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });

  const removeWebhook = useMutation({
    mutationFn: (id: string) => api.delete(`/webhooks/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["webhooks"] }),
  });

  /**
   * Sends a signed sample immediately. Worth a button: the alternative is
   * wiring up a receiver, waiting for something to happen, and guessing which
   * end is wrong when nothing arrives.
   */
  const testWebhook = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; status: number; error?: string }>(
        `/webhooks/${id}/test`,
        {},
      ),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(`Receiver answered ${result.status}`);
      } else {
        toast.danger("The receiver did not accept it", {
          description: result.error || `HTTP ${result.status}`,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
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
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Planning cadence</Card.Title>
          <p className="text-xs opacity-50">
            Cadence lives on each plan now, not on the workspace — a founder account
            can post daily while a brand account posts weekly.
          </p>
        </Card.Header>
        <Card.Content>
          <Link href="/plans">
            <Button size="sm" variant="secondary">
              Open plans
            </Button>
          </Link>
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

          <div className="flex flex-wrap items-end gap-2">
            <Select
              selectedKey={target.kind}
              onSelectionChange={(key) =>
                setTarget((t) => ({ ...t, kind: String(key) }))
              }
              className="w-36"
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBoxItem id="slack">Slack</ListBoxItem>
                  <ListBoxItem id="discord">Discord</ListBoxItem>
                  <ListBoxItem id="email">Email</ListBoxItem>
                </ListBox>
              </Select.Popover>
            </Select>

            <div className="min-w-48 flex-1">
              <Field
                value={target.value}
                onChange={(value) => setTarget((t) => ({ ...t, value }))}
                type={target.kind === "email" ? "email" : "url"}
                placeholder={
                  target.kind === "email" ? "you@example.com" : "https://hooks.slack.com/…"
                }
              />
            </div>

            <Button onPress={() => addTarget.mutate()} isDisabled={!target.value}>
              Add
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Model provider</Card.Title>
          <p className="text-xs opacity-50">
            Set by environment, not here — a key belongs in the deployment, and the
            models are tiered by role on purpose: strategy and writing get the capable
            one, triage-volume work gets the cheap one. Override with ZEST_MODEL /
            ZEST_MODEL_CHEAP if you must.
          </p>
        </Card.Header>
        <Card.Content>
          {me?.capabilities?.llm ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Chip size="sm" variant="soft" color="success">
                  {me.capabilities.provider ?? "configured"}
                </Chip>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs opacity-60">
                <span>writing &amp; strategy: {me.capabilities.model ?? "default"}</span>
                <span>
                  triage &amp; simulated audience: {me.capabilities.cheapModel ?? "default"}
                </span>
                <span>
                  chat recall:{" "}
                  {me.capabilities.recall?.enabled
                    ? me.capabilities.recall.model
                    : `off — ${me.capabilities.recall?.reason ?? "not available"}`}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm opacity-60">
              None configured. Set <code>OPENROUTER_API_KEY</code>,{" "}
              <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> and restart.
              The platform loop works without one.
            </p>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Outbound webhooks</Card.Title>
          <p className="text-xs opacity-50">
            Every domain event, posted to your own endpoint — for n8n, Zapier, or
            anything you have built. Each delivery is signed with{" "}
            <code>X-Zest-Signature</code>; verify it before trusting the body.
          </p>
        </Card.Header>
        <Card.Content className="space-y-3">
          {newSecret && (
            <div className="rounded-lg bg-success/10 px-3 py-2 text-sm">
              <div className="font-medium text-success">
                Copy this signing secret now — it is not shown again.
              </div>
              <code className="mt-1 block break-all text-xs">{newSecret}</code>
            </div>
          )}

          {webhooks.map((hook) => (
            <div key={hook.id} className="rounded-lg bg-default-100/60 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{hook.url}</span>
                    {hook.isActive !== "true" && (
                      <Chip size="sm" variant="soft" color="danger">
                        disabled
                      </Chip>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs opacity-55">
                    {hook.eventTypes.length === 0
                      ? "all meaningful events"
                      : hook.eventTypes.join(", ")}
                    {hook.lastDeliveredAt &&
                      ` · last delivered ${relativeTime(hook.lastDeliveredAt)}`}
                    {hook.consecutiveFailures > 0 &&
                      ` · ${hook.consecutiveFailures} failures in a row`}
                  </div>
                  {hook.lastError && (
                    <div className="mt-0.5 truncate text-xs text-danger">
                      {hook.lastError}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => testWebhook.mutate(hook.id)}
                    isPending={testWebhook.isPending}
                  >
                    Send test
                  </Button>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => removeWebhook.mutate(hook.id)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <Field
                value={webhookUrl}
                onChange={setWebhookUrl}
                type="url"
                placeholder="https://your-service.example/zest"
              />
            </div>
            <Button onPress={() => addWebhook.mutate()} isDisabled={!webhookUrl}>
              Add endpoint
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
            <div className="rounded-lg bg-success/10 px-3 py-2 text-sm">
              <div className="font-medium text-success">
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
