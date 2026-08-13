"use client";

import { Avatar, ListBox, ListBoxItem, Select } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { api, type Account } from "@/lib/api";

/**
 * Choosing which account you are looking at.
 *
 * This was a row of tabs, which reads fine with two accounts and falls apart at
 * six — the row wraps, the labels truncate, and the one you want is off the
 * end. A select stays one control at any count, shows the avatar and platform
 * so two similar handles are still distinguishable, and keeps the workspace
 * option first where it belongs.
 */

export const WORKSPACE = "__workspace__";

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });
}

export function AccountSwitcher({
  value,
  onChange,
  /** Label for the "not a specific account" option; omit to require one. */
  workspaceLabel,
  className,
}: {
  value: string | null;
  onChange: (accountId: string | null) => void;
  workspaceLabel?: string;
  className?: string;
}) {
  const { data: accounts = [] } = useAccounts();

  const selected = value ?? WORKSPACE;
  const current = accounts.find((a) => a.id === selected);

  return (
    <Select
      selectedKey={selected}
      onSelectionChange={(key) => {
        const next = String(key);
        onChange(next === WORKSPACE ? null : next);
      }}
      className={className ?? "w-60"}
      aria-label="Account"
    >
      <Select.Trigger>
        <span className="flex min-w-0 items-center gap-2">
          {current ? (
            <>
              <Avatar className="size-5 shrink-0">
                {current.avatarUrl ? (
                  <Avatar.Image src={current.avatarUrl} alt="" />
                ) : (
                  <Avatar.Fallback className="text-[10px]">
                    {current.handle.slice(0, 2)}
                  </Avatar.Fallback>
                )}
              </Avatar>
              <span className="truncate">@{current.handle}</span>
            </>
          ) : (
            <span className="truncate">{workspaceLabel ?? "Whole workspace"}</span>
          )}
        </span>
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {[
            ...(workspaceLabel
              ? [
                  <ListBoxItem key={WORKSPACE} id={WORKSPACE} textValue={workspaceLabel}>
                    <div className="font-medium">{workspaceLabel}</div>
                    <div className="text-xs opacity-55">
                      Shared by every account
                    </div>
                  </ListBoxItem>,
                ]
              : []),
            ...accounts.map((account) => (
              <ListBoxItem
                key={account.id}
                id={account.id}
                textValue={`@${account.handle}`}
              >
                <div className="flex items-center gap-2">
                  <Avatar className="size-6 shrink-0">
                    {account.avatarUrl ? (
                      <Avatar.Image src={account.avatarUrl} alt="" />
                    ) : (
                      <Avatar.Fallback className="text-[10px]">
                        {account.handle.slice(0, 2)}
                      </Avatar.Fallback>
                    )}
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium">@{account.handle}</div>
                    {/* Two accounts on different platforms can share a handle. */}
                    <div className="text-xs opacity-55">
                      {account.platform?.name ?? account.connectorId}
                    </div>
                  </div>
                </div>
              </ListBoxItem>
            )),
          ]}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
