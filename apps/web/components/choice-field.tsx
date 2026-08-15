"use client";

import { Label, Radio, RadioGroup } from "@heroui/react";
import type { ReactNode } from "react";

/**
 * A choice that is part of a form.
 *
 * Cadence and programme kind were segmented controls, which looked right and
 * read wrong: they sit inside a form, they are submitted with it, and a screen
 * reader announced them as a tab list — "switching views" — rather than a
 * question with options. A radio group says what they are, gets arrow-key
 * navigation and a group label for free, and keeps the same one-line call site.
 *
 * The visual difference from `Segmented` is deliberate too: tabs sit above the
 * thing they filter, form choices sit under a label beside the other fields.
 */
export function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; description?: string }[];
  onChange: (value: T) => void;
  hint?: ReactNode;
}) {
  return (
    <RadioGroup
      value={value}
      onChange={(next) => onChange(next as T)}
      aria-label={label}
    >
      <Label className="mb-1.5 block text-sm font-medium">{label}</Label>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Radio key={option.id} value={option.id}>
            {/*
              `Radio` is the field wrapper; `Radio.Content` is the label that
              carries the actual input and the press/focus handling. Styling the
              wrapper alone looked right and rendered no radio at all — no
              keyboard selection, nothing for a screen reader to announce.
            */}
            <Radio.Content
              className={[
                "cursor-pointer rounded-xl border px-3 py-2 text-sm",
                "transition-[background-color,border-color,transform] duration-150 ease-out",
                "data-[hovered]:border-default-400 data-[hovered]:bg-default-100/60",
                "data-[pressed]:scale-[0.98]",
                "data-[selected]:border-accent data-[selected]:bg-accent/10 data-[selected]:font-medium data-[selected]:shadow-sm",
                "border-default-200/70",
                "data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent/50",
              ].join(" ")}
            >
              <span className="block">
                <span className="block">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-xs font-normal opacity-55">
                    {option.description}
                  </span>
                )}
              </span>
            </Radio.Content>
          </Radio>
        ))}
      </div>
      {hint && <p className="mt-1.5 text-xs opacity-50">{hint}</p>}
    </RadioGroup>
  );
}
