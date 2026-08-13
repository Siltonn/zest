"use client";

import { Button, Card, Chip, Spinner, TextArea } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { api, type Account } from "@/lib/api";
import { Segmented } from "@/components/segmented";
import { percent } from "@/lib/format";

type VariantResult = {
  id: string;
  text: string;
  score: number;
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  quality: number;
  topArchetypes: string[];
};

type Report = {
  variants: VariantResult[];
  winner: VariantResult | null;
  inconclusive?: string;
};

type Automation = {
  id: string;
  kind: string;
  trigger: { threshold?: number; sentiment?: string; keywords?: string[] };
  template: string | null;
};

/**
 * The wind tunnel and the automation rules.
 *
 * Testing copy against a simulated audience before it reaches a live account is
 * only possible because Zest ships its own network — no other scheduler can
 * offer a dry run.
 */
export default function LabPage() {
  const queryClient = useQueryClient();
  const [variants, setVariants] = useState(["", ""]);
  const [accountId, setAccountId] = useState<string | null>(null);

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const { data: automations = [] } = useQuery({
    queryKey: ["automations"],
    queryFn: () => api.get<Automation[]>("/automations"),
  });

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];

  const test = useMutation({
    mutationFn: () =>
      api.post<Report>("/wind-tunnel", {
        accountId: account?.id,
        variants: variants
          .map((text, i) => ({ id: String.fromCharCode(65 + i), text }))
          .filter((v) => v.text.trim().length > 0),
      }),
  });

  const addAutomation = useMutation({
    mutationFn: (input: unknown) => api.post("/automations", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });

  const removeAutomation = useMutation({
    mutationFn: (id: string) => api.delete(`/automations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Lab</h1>
        <p className="text-sm opacity-60">
          Try copy against Pomelo's audience before it goes anywhere real, and set up
          the small mechanical actions you would rather not do by hand.
        </p>
      </header>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Wind tunnel</Card.Title>
          <p className="text-xs opacity-50">
            Same audience, same seed, different words — so any difference comes from
            the writing. A comparison, not a prediction.
          </p>
        </Card.Header>
        <Card.Content className="space-y-3">
          {account && (
            <Segmented
              value={account.id}
              onChange={setAccountId}
              options={accounts.map((a) => ({ id: a.id, label: `@${a.handle}` }))}
            />
          )}

          {variants.map((text, index) => (
            <div key={index}>
              <div className="mb-1 text-xs font-medium opacity-50">
                Variant {String.fromCharCode(65 + index)}
              </div>
              <TextArea
                value={text}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setVariants((v) =>
                    v.map((item, i) => (i === index ? e.target.value : item)),
                  )
                }
                rows={3}
              />
            </div>
          ))}

          <div className="flex gap-2">
            <Button
              onPress={() => test.mutate()}
              isPending={test.isPending}
              isDisabled={variants.filter((v) => v.trim()).length < 2 || !account}
            >
              Run the test
            </Button>
            {variants.length < 4 && (
              <Button
                variant="tertiary"
                onPress={() => setVariants((v) => [...v, ""])}
              >
                Add a variant
              </Button>
            )}
          </div>

          {test.data && (
            <div className="space-y-2 pt-2">
              {test.data.inconclusive && (
                <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
                  {test.data.inconclusive}
                </div>
              )}
              {test.data.variants.map((variant) => {
                const won = test.data?.winner?.id === variant.id;
                return (
                  <div
                    key={variant.id}
                    className={`rounded-lg border p-3 ${
                      won ? "border-emerald-500/50 bg-emerald-500/5" : "border-default-200/60"
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-medium">Variant {variant.id}</span>
                      {won && (
                        <Chip size="sm" variant="soft" color="success">
                          stronger
                        </Chip>
                      )}
                      <span className="text-sm opacity-50">
                        {percent(variant.score)} engagement
                      </span>
                    </div>
                    <p className="text-sm opacity-80">{variant.text}</p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs opacity-50">
                      <span>{variant.impressions} saw it</span>
                      <span>♥ {variant.likes}</span>
                      <span>🔁 {variant.reposts}</span>
                      <span>💬 {variant.replies}</span>
                      {variant.topArchetypes.length > 0 && (
                        <span>resonated with: {variant.topArchetypes.join(", ")}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {test.isError && (
            <p className="text-sm text-red-500">{(test.error as Error).message}</p>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Engagement automations</Card.Title>
          <p className="text-xs opacity-50">
            Rules, not judgement — so they are predictable. They still need autonomy
            granted before they fire.
          </p>
        </Card.Header>
        <Card.Content className="space-y-3">
          {automations.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-lg bg-default-100/60 px-3 py-2 text-sm"
            >
              <div>
                <span className="font-medium">{item.kind.replace(/_/g, "-")}</span>
                <span className="opacity-50">
                  {item.trigger.threshold && ` past ${item.trigger.threshold} interactions`}
                  {item.trigger.sentiment && ` on ${item.trigger.sentiment} comments`}
                  {item.trigger.keywords && ` matching ${item.trigger.keywords.join(", ")}`}
                </span>
                {item.template && (
                  <div className="text-xs opacity-40">"{item.template}"</div>
                )}
              </div>
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => removeAutomation.mutate(item.id)}
              >
                Remove
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() =>
                addAutomation.mutate({
                  kind: "auto_plug",
                  trigger: { threshold: 25 },
                  template: "If this was useful, the full write-up is on our blog.",
                })
              }
            >
              Add auto-plug
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onPress={() =>
                addAutomation.mutate({
                  kind: "auto_reply",
                  trigger: { sentiment: "positive" },
                  template: "Thanks — glad it was useful.",
                })
              }
            >
              Add auto-reply
            </Button>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
