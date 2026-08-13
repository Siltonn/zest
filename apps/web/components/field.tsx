"use client";

import { Description, Input, Label, TextField } from "@heroui/react";
import type { ComponentProps } from "react";

/**
 * A labelled text input.
 *
 * Every form in the app goes through this so spacing, focus rings and
 * label association are identical everywhere — and so nobody has to remember
 * to wire `htmlFor` by hand. HeroUI's TextField supplies the association.
 */
export function Field({
  label,
  description,
  type = "text",
  value,
  onChange,
  placeholder,
  isRequired,
  autoFocus,
  ...rest
}: {
  label?: string;
  description?: string;
  type?: ComponentProps<typeof Input>["type"];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  isRequired?: boolean;
  autoFocus?: boolean;
} & Omit<ComponentProps<typeof TextField>, "value" | "onChange" | "type">) {
  return (
    <TextField
      value={value}
      // react-aria hands back the string, not an event — one fewer thing to
      // get wrong at each call site.
      onChange={onChange}
      isRequired={isRequired}
      className="w-full"
      {...rest}
    >
      {label && <Label>{label}</Label>}
      <Input type={type} placeholder={placeholder} autoFocus={autoFocus} />
      {description && <Description>{description}</Description>}
    </TextField>
  );
}
