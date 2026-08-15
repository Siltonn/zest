"use client";

import { Tabs } from "@heroui/react";

/**
 * Switching which view or slice of one region you are looking at.
 *
 * This was hand-rolled on ToggleButtonGroup because of a note that react-aria's
 * Tabs "will not change selection without matching panels". That was wrong:
 * `Tabs` drives selection from `selectedKey`/`onSelectionChange` and renders
 * whatever panels you give it, including none. Believing it cost us the thing
 * Tabs brings for free — `Tabs.Indicator` is react-aria's SelectionIndicator,
 * which coordinates a shared-element transition between items so the active
 * background slides rather than snapping.
 *
 * The indicator goes *inside* each tab, not in the list: each item supplies its
 * own `isSelected`, and react-aria animates between the mounted ones. Rendering
 * one loose in the list throws "SharedElement must be rendered inside a
 * SharedElementTransition" — at build time during prerender, which is a good
 * place to find out.
 *
 * Use this for views and filters. A choice that is part of a form belongs in
 * `ChoiceField`, which is a radio group: a screen reader should hear "radio
 * group, Cadence", not "tab list".
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md" | "lg";
  /** Names the control for assistive tech; visually hidden. */
  label?: string;
}) {
  const text = size === "sm" ? "text-xs" : size === "lg" ? "text-base" : "text-sm";
  const pad = size === "sm" ? "px-2.5 py-1" : size === "lg" ? "px-4 py-2" : "px-3 py-1.5";

  return (
    <Tabs
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key) as T)}
      aria-label={label ?? "View"}
    >
      <Tabs.List
        className={`inline-flex gap-0.5 rounded-xl bg-default-100/70 p-1 ${text}`}
      >
        {options.map((option) => (
          <Tabs.Tab
            key={option.id}
            id={option.id}
            // Styled off react-aria's data attributes rather than a render
            // prop: HeroUI types `className` as a string, and the attributes
            // carry hover and press states the render prop would not.
            className={[
              "group relative cursor-pointer select-none whitespace-nowrap rounded-lg outline-none",
              "transition-[opacity,transform,color] duration-150 ease-out",
              pad,
              // The indicator paints the selected surface, so the label only
              // changes colour — otherwise a solid box appears instantly and
              // hides the slide underneath it.
              //
              // 75 rather than the 60 used for muted text elsewhere: these
              // labels sit on the track, which is lighter than the page, so the
              // same opacity buys less contrast here — measured 3.3:1 at 60,
              // and an unselected tab is a control you have to be able to read.
              "opacity-75 data-[selected]:text-accent-soft-foreground data-[selected]:opacity-100",
              "data-[hovered]:opacity-100",
              // A small press response makes the control feel physical without
              // moving the layout.
              "data-[pressed]:scale-[0.97]",
              "data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent/50",
            ].join(" ")}
          >
            {/* Under the label: the shared element that slides between tabs.
                Tinted with the accent rather than raised as a lighter pill —
                at this theme's lightness a "raised" surface in dark mode ends
                up darker than the track it sits on. */}
            <Tabs.Indicator className="absolute inset-0 -z-10 rounded-lg bg-accent-soft ring-1 ring-accent/25" />

            {/*
              Selection bolds the label, and a bold label is wider — enough that
              "30 days" stopped fitting its equal-width tab and wrapped onto two
              lines. A hidden bold copy reserves the wider measurement always,
              so switching tabs changes weight without moving anything.
            */}
            <span className="relative block">
              <span aria-hidden className="invisible block font-medium">
                {option.label}
              </span>
              <span className="absolute inset-0 flex items-center justify-center group-data-[selected]:font-medium">
                {option.label}
              </span>
            </span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
