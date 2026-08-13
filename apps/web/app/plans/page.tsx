"use client";

import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Spinner,
  TextArea,
  ToggleButton,
  ToggleButtonGroup,
  toast,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type ChangeEvent } from "react";
import { api, type Account } from "@/lib/api";
import { ConfirmButton } from "@/components/confirm-button";
import { Segmented } from "@/components/segmented";
import { formatDateTime, relativeTime } from "@/lib/format";

/**
 * Content programmes.
 *
 * The cadence used to live on the workspace, which said every account moves at
 * the same speed. A plan names the accounts it writes for and carries its own
 * rhythm, so an always-on founder programme and a launch week spanning both
 * accounts are the same mechanism rather than two features.
 */

type PlanItem = {
  id: string;
  accountId: string;
  topic: string;
  angle: string | null;
  suggestedSlotAt: string | null;
  status: "planned" | "written" | "skipped";
  postId: string | null;
};

type Plan = {
  id: string;
  name: string;
  objective: string | null;
  schedule: string;
  status: "active" | "paused" | "archived";
  startsAt: string | null;
  endsAt: string | null;
  accountIds: string[];
  itemCounts: { planned: number; written: number; skipped: number };
};

const CADENCES = [
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Weekly" },
  { id: "manual", label: "Manual" },
];

export default function PlansPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["plans"],
    queryFn: () => api.get<Plan[]>("/plans"),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["plans"] });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="text-sm opacity-60">
            Each programme has its own cadence and writes for the accounts it names.
            Research is shared across them, so the accounts stay coordinated.
          </p>
        </div>
        <Button onPress={() => setCreating((open) => !open)}>
          {creating ? "Cancel" : "New plan"}
        </Button>
      </header>

      {accounts.length === 0 && (
        <Card>
          <Card.Content className="py-8 text-center">
            <p className="opacity-60">
              Connect an account first — a plan has to have somewhere to post.
            </p>
            <Link href="/accounts" className="mt-3 inline-block">
              <Button size="sm">Connect an account</Button>
            </Link>
          </Card.Content>
        </Card>
      )}

      {creating && accounts.length > 0 && (
        <PlanForm
          accounts={accounts}
          onDone={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      {plans.length === 0 && accounts.length > 0 && !creating ? (
        <Card>
          <Card.Content className="py-10 text-center">
            <p className="opacity-60">
              No programmes yet. A plan is what gives the agent a reason and a rhythm
              to post — without one, nothing is scheduled.
            </p>
          </Card.Content>
        </Card>
      ) : (
        plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            accounts={accounts}
            isOpen={expanded === plan.id}
            onToggle={() => setExpanded(expanded === plan.id ? null : plan.id)}
            onChanged={refresh}
          />
        ))
      )}
    </div>
  );
}

function PlanForm({
  accounts,
  onDone,
}: {
  accounts: Account[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [schedule, setSchedule] = useState("weekly");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const create = useMutation({
    mutationFn: () =>
      api.post("/plans", {
        name,
        objective: objective || undefined,
        schedule,
        accountIds: [...selected],
      }),
    onSuccess: () => {
      toast.success("Plan created", {
        description:
          schedule === "manual"
            ? "Run it from here whenever you want."
            : `It will run ${schedule}.`,
      });
      onDone();
    },
    onError: (error: Error) =>
      toast.danger("Could not create the plan", { description: error.message }),
  });

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">New plan</Card.Title>
      </Card.Header>
      <Card.Content className="space-y-4">
        <div>
          <Label className="mb-1 block text-sm font-medium">Name</Label>
          <Input
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            placeholder="Launch week, Always-on, Hiring push…"
          />
        </div>

        <div>
          <Label className="mb-1 block text-sm font-medium">
            What is it for{" "}
            <span className="font-normal opacity-50">— the strategist reads this</span>
          </Label>
          <TextArea
            value={objective}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              setObjective(e.target.value)
            }
            rows={2}
            placeholder="Get developers to try the new scheduler, without sounding like a press release."
          />
        </div>

        <div>
          <Label className="mb-1.5 block text-sm font-medium">Cadence</Label>
          <Segmented value={schedule} onChange={setSchedule} options={CADENCES} />
        </div>

        <div>
          <Label className="mb-1.5 block text-sm font-medium">
            Accounts{" "}
            <span className="font-normal opacity-50">
              — pick more than one for a campaign that spans them
            </span>
          </Label>
          <ToggleButtonGroup
            selectionMode="multiple"
            selectedKeys={selected}
            onSelectionChange={(keys) => setSelected(new Set([...keys] as string[]))}
            size="sm"
          >
            {accounts.map((account) => (
              <ToggleButton key={account.id} id={account.id}>
                @{account.handle}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </div>
      </Card.Content>
      <Card.Footer>
        <Button
          onPress={() => create.mutate()}
          isPending={create.isPending}
          isDisabled={!name.trim() || selected.size === 0}
        >
          Create plan
        </Button>
      </Card.Footer>
    </Card>
  );
}

function PlanCard({
  plan,
  accounts,
  isOpen,
  onToggle,
  onChanged,
}: {
  plan: Plan;
  accounts: Account[];
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: detail } = useQuery({
    queryKey: ["plan", plan.id],
    queryFn: () =>
      api.get<{ plan: Plan; accountIds: string[]; items: PlanItem[] }>(
        `/plans/${plan.id}`,
      ),
    enabled: isOpen,
  });

  const run = useMutation({
    mutationFn: () => api.post(`/plans/${plan.id}/run`),
    onSuccess: () =>
      toast.success(`Running "${plan.name}"`, {
        description:
          "Research first, then this plan's strategist, then a writer per account.",
      }),
    onError: (error: Error) =>
      toast.danger("Cannot run this plan", { description: error.message }),
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.post(`/plans/${plan.id}`, patch),
    onSuccess: onChanged,
    onError: (error: Error) =>
      toast.danger("Could not save", { description: error.message }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/plans/${plan.id}`),
    onSuccess: () => {
      toast.success("Plan deleted");
      onChanged();
    },
  });

  const skip = useMutation({
    mutationFn: (itemId: string) => api.post(`/plans/items/${itemId}/skip`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plan", plan.id] });
      onChanged();
    },
  });

  const handleFor = (id: string) =>
    accounts.find((a) => a.id === id)?.handle ?? "unknown";

  const paused = plan.status !== "active";

  return (
    <Card className={paused ? "opacity-70" : ""}>
      <Card.Header className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Card.Title className="text-base">{plan.name}</Card.Title>
            <Chip size="sm" variant="soft" color={paused ? "default" : "success"}>
              {plan.status}
            </Chip>
            <Chip size="sm" variant="soft">
              {plan.schedule}
            </Chip>
          </div>
          {plan.objective && (
            <p className="mt-1 text-sm opacity-60">{plan.objective}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs opacity-55">
            {plan.accountIds.map((id) => (
              <span key={id} className="rounded bg-default-100 px-1.5 py-0.5">
                @{handleFor(id)}
              </span>
            ))}
            {(plan.startsAt || plan.endsAt) && (
              <span>
                ·{" "}
                {plan.startsAt ? formatDateTime(plan.startsAt) : "any time"} →{" "}
                {plan.endsAt ? formatDateTime(plan.endsAt) : "open-ended"}
              </span>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right text-xs opacity-55">
          <div>{plan.itemCounts.planned} to write</div>
          <div>{plan.itemCounts.written} written</div>
        </div>
      </Card.Header>

      <Card.Footer className="flex flex-wrap gap-2">
        <Button size="sm" onPress={() => run.mutate()} isPending={run.isPending}>
          Run now
        </Button>
        <Button size="sm" variant="secondary" onPress={onToggle}>
          {isOpen ? "Hide plan" : `Show plan (${plan.itemCounts.planned + plan.itemCounts.written})`}
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() =>
            update.mutate({ status: paused ? "active" : "paused" })
          }
          isPending={update.isPending}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        <ConfirmButton
          label="Delete"
          title={`Delete "${plan.name}"?`}
          body={
            <>
              Its schedule stops and its {plan.itemCounts.planned + plan.itemCounts.written}{" "}
              planned and written items go with it. Posts already published stay up.
            </>
          }
          confirmLabel="Delete the plan"
          onConfirm={() => remove.mutate()}
          isPending={remove.isPending}
        />
      </Card.Footer>

      {isOpen && (
        <Card.Content className="border-t border-default-200/60 pt-4">
          {!detail ? (
            <Spinner />
          ) : detail.items.length === 0 ? (
            <p className="text-sm opacity-55">
              Nothing planned yet. Run the plan and the strategist will fill this in —
              you can drop or reword any item before the copywriter picks it up.
            </p>
          ) : (
            <div className="space-y-4">
              {detail.accountIds.map((accountId) => {
                const items = detail.items.filter((i) => i.accountId === accountId);
                if (items.length === 0) return null;
                return (
                  <div key={accountId}>
                    <div className="mb-1.5 text-xs font-medium uppercase tracking-wide opacity-50">
                      @{handleFor(accountId)}
                    </div>
                    <div className="space-y-1.5">
                      {items.map((item) => (
                        <div
                          key={item.id}
                          className={`rounded-lg border border-default-200/60 px-3 py-2 text-sm ${
                            item.status === "skipped" ? "opacity-40 line-through" : ""
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium">{item.topic}</div>
                              {item.angle && (
                                <div className="text-xs opacity-60">{item.angle}</div>
                              )}
                              <div className="mt-0.5 text-xs opacity-45">
                                {item.suggestedSlotAt
                                  ? formatDateTime(item.suggestedSlotAt)
                                  : "no slot"}
                                {" · "}
                                {item.status}
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-1.5">
                              {item.postId && (
                                <Link href={`/calendar?post=${item.postId}`}>
                                  <Button size="sm" variant="tertiary">
                                    See the post
                                  </Button>
                                </Link>
                              )}
                              {item.status === "planned" && (
                                <Button
                                  size="sm"
                                  variant="tertiary"
                                  onPress={() => skip.mutate(item.id)}
                                  isPending={skip.isPending}
                                >
                                  Skip
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card.Content>
      )}
    </Card>
  );
}
