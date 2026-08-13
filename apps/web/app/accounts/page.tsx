"use client";

import { Button, Card, Chip, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Account } from "@/lib/api";

type Platform = {
  id: string;
  name: string;
  icon: string;
  charLimit: number;
  features: string[];
  setupHint?: string;
};

/**
 * Connecting accounts.
 *
 * Every self-hoster brings their own platform credentials, because platform
 * apps cannot be shared — which is exactly why Pomelo exists: one click, no
 * developer account, and the whole loop is testable.
 */
export default function AccountsPage() {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const { data: platforms = [] } = useQuery({
    queryKey: ["platforms"],
    queryFn: () => api.get<Platform[]>("/platforms"),
  });

  const connect = useMutation({
    mutationFn: (connectorId: string) =>
      api.post("/accounts", { connectorId, fields }),
    onSuccess: () => {
      setConnecting(null);
      setFields({});
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.delete(`/accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
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
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-sm opacity-60">
          Pomelo connects instantly. Real platforms need credentials you supply — Zest
          never asks you to trust a shared app.
        </p>
      </header>

      {accounts.length > 0 && (
        <Card>
          <Card.Header>
            <Card.Title className="text-sm">Connected</Card.Title>
          </Card.Header>
          <Card.Content className="p-0">
            <ul className="divide-y divide-default-200/60">
              {accounts.map((account) => (
                <li key={account.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="text-lg">{account.platform?.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">@{account.handle}</div>
                    <div className="text-xs opacity-50">
                      {account.platform?.name ?? account.connectorId}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => disconnect.mutate(account.id)}
                  >
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          </Card.Content>
        </Card>
      )}

      <div className="space-y-3">
        {platforms.map((platform) => (
          <Card key={platform.id}>
            <Card.Header className="flex flex-row items-start justify-between gap-3">
              <div className="flex gap-3">
                <span className="text-xl">{platform.icon}</span>
                <div>
                  <Card.Title className="text-base">{platform.name}</Card.Title>
                  <p className="mt-0.5 text-xs opacity-50">
                    {platform.charLimit} characters · {platform.features.join(", ")}
                  </p>
                  {platform.setupHint && (
                    <p className="mt-1 text-xs opacity-60">{platform.setupHint}</p>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant={platform.id === "pomelo" ? "primary" : "secondary"}
                onPress={() =>
                  setConnecting(connecting === platform.id ? null : platform.id)
                }
              >
                Connect
              </Button>
            </Card.Header>

            {connecting === platform.id && (
              <Card.Content className="space-y-2">
                {fieldsFor(platform.id).map((field) => (
                  <input
                    key={field.name}
                    type={field.type}
                    placeholder={field.placeholder}
                    value={fields[field.name] ?? ""}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, [field.name]: e.target.value }))
                    }
                    className="w-full rounded-lg border border-default-200/60 bg-transparent px-3 py-2 text-sm"
                  />
                ))}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onPress={() => connect.mutate(platform.id)}
                    isPending={connect.isPending}
                  >
                    Connect
                  </Button>
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => setConnecting(null)}
                  >
                    Cancel
                  </Button>
                </div>
                {connect.isError && (
                  <p className="text-sm text-red-500">
                    {(connect.error as Error).message}
                  </p>
                )}
              </Card.Content>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Mirrors each connector's declared auth fields. */
function fieldsFor(
  connectorId: string,
): { name: string; type: string; placeholder: string }[] {
  switch (connectorId) {
    case "pomelo":
      return [
        { name: "handle", type: "text", placeholder: "handle, e.g. acme" },
        { name: "displayName", type: "text", placeholder: "display name" },
      ];
    case "bluesky":
      return [
        { name: "handle", type: "text", placeholder: "you.bsky.social" },
        { name: "appPassword", type: "password", placeholder: "app password" },
        { name: "service", type: "url", placeholder: "https://bsky.social (optional)" },
      ];
    case "mastodon":
      return [
        { name: "instance", type: "url", placeholder: "https://mastodon.social" },
        { name: "accessToken", type: "password", placeholder: "access token" },
      ];
    default:
      return [];
  }
}
