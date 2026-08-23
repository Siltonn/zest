"use client";

import { Button, Dropdown, Input, Label, Modal, toast } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { api, type WorkspaceSummary } from "@/lib/api";
import { CheckIcon, ChevronUpDownIcon, PlusIcon } from "./icons";

/**
 * Which workspace you are in, and the way into another one.
 *
 * The server keeps the choice in an HttpOnly cookie, so both switching and
 * creating end in a hard navigation: every query, the event stream and any
 * page state belong to the old workspace and must not survive into the new.
 */
export function WorkspaceSwitcher({ currentName }: { currentName?: string }) {
  const [creating, setCreating] = useState(false);

  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.get<WorkspaceSummary[]>("/workspaces"),
  });

  const switchTo = useMutation({
    mutationFn: (id: string) => api.post(`/workspaces/${id}/switch`),
    // A document load, not a router push: switching workspaces changes a
    // server cookie, and a client-side navigation would keep the query cache
    // and the prefetched payloads of the workspace being left behind.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    onSuccess: () => window.location.assign("/"),
    onError: (error: Error) =>
      toast.danger("Could not switch workspace", { description: error.message }),
  });

  const label = currentName ?? workspaces.find((w) => w.current)?.name ?? "…";

  return (
    <>
      <Dropdown>
        <Dropdown.Trigger
          className="group flex max-w-full items-center gap-1 rounded text-xs leading-tight opacity-60 transition-opacity hover:opacity-100"
          aria-label="Switch workspace"
        >
          <span className="truncate">{label}</span>
          <ChevronUpDownIcon className="size-3 shrink-0" />
        </Dropdown.Trigger>

        <Dropdown.Popover placement="bottom start" className="w-60">
          <Dropdown.Menu>
            {workspaces.map((workspace) => (
              <Dropdown.Item
                key={workspace.id}
                id={workspace.id}
                onAction={() => {
                  if (!workspace.current) switchTo.mutate(workspace.id);
                }}
              >
                <span className="flex-1 truncate">{workspace.name}</span>
                {workspace.current && <CheckIcon className="size-4" />}
              </Dropdown.Item>
            ))}
            <Dropdown.Item id="new-workspace" onAction={() => setCreating(true)}>
              <PlusIcon className="size-4 opacity-70" />
              New workspace
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <NewWorkspaceDialog isOpen={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewWorkspaceDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.post<WorkspaceSummary>("/workspaces", {
        name: name.trim(),
        // The server stores UTC either way; this only sets the display zone
        // so the new workspace's calendar reads in local time from the start.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    // The cookie now points at the new workspace — land on its dashboard,
    // where onboarding explains what an empty workspace needs next. A full
    // load for the same reason as above: the cached payloads belong to the
    // workspace being left.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    onSuccess: () => window.location.assign("/"),
    onError: (error: Error) =>
      toast.danger("Could not create the workspace", {
        description: error.message,
      }),
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>New workspace</Modal.Heading>
              <p className="text-sm opacity-60">
                A separate brand with its own accounts, memory and plans. You
                will switch straight into it.
              </p>
            </Modal.Header>
            <Modal.Body>
              <Label className="mb-1 block text-sm font-medium">Name</Label>
              <Input
                value={name}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setName(e.target.value)
                }
                placeholder="Acme, Side project, Client X…"
                autoFocus
              />
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onPress={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onPress={() => create.mutate()}
                isPending={create.isPending}
                isDisabled={!name.trim()}
              >
                Create workspace
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
