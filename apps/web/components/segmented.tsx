"use client";

import { ToggleButton, ToggleButtonGroup } from "@heroui/react";

/**
 * A segmented control for switching views.
 *
 * Deliberately not HeroUI's Tabs: react-aria's Tabs expect matching panels and
 * will not change selection without them, and a view switch is not a tab set
 * anyway — there is one region of content, shown differently.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <ToggleButtonGroup
      selectionMode="single"
      // Without this, clicking the selected option clears it and leaves the
      // view in no state at all.
      disallowEmptySelection
      selectedKeys={new Set([value])}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next) onChange(next as T);
      }}
      size={size}
    >
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
