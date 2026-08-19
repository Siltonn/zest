"use client";

import { AlertDialog, Button } from "@heroui/react";
import type { ReactNode } from "react";

/**
 * A destructive action that asks first.
 *
 * Deleting a plan takes its items and its schedule with it; disconnecting an
 * account takes its voice card and its history. Both were one unguarded click
 * next to buttons you press all day, which is the kind of thing you only notice
 * is missing once. The dialog states what is lost rather than asking a generic
 * "are you sure".
 */
export function ConfirmButton({
  label,
  title,
  body,
  confirmLabel,
  onConfirm,
  isPending,
  variant = "tertiary",
}: {
  label: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
  variant?: "primary" | "secondary" | "tertiary";
}) {
  return (
    <AlertDialog>
      <AlertDialog.Trigger>
        <Button size="sm" variant={variant} isPending={isPending}>
          {label}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          {/* Plain buttons that call `close`, not CloseTrigger wrappers:
              CloseTrigger is itself a button, so nesting a Button inside it
              renders <button><button> — invalid HTML and a hydration error. */}
          <AlertDialog.Dialog>
            {({ close }) => (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>{title}</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>{body}</AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button variant="tertiary" onPress={close}>
                    Keep it
                  </Button>
                  <Button
                    variant="primary"
                    onPress={() => {
                      close();
                      onConfirm();
                    }}
                  >
                    {confirmLabel}
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
