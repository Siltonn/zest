"use client";

import { Button, Tooltip, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ForwardIcon } from "./icons";

/**
 * Advances Pomelo's simulated clock by a day.
 *
 * This lives on the Pomelo surfaces, not in the global sidebar: it is a Pomelo
 * feature. Next to Inbox and Plans it read as if it fast-forwarded all of Zest,
 * and real platforms keep real time.
 */
export function FastForwardButton({ size }: { size?: "sm" | "md" }) {
  const queryClient = useQueryClient();

  const fastForward = useMutation({
    mutationFn: () =>
      api.post<{ released: number; replies: number }>("/simulator/fast-forward", {
        days: 1,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      // An action with no visible result has to say what it did, or it reads
      // as a broken button.
      toast.success(
        result.released > 0
          ? `A day passed on Pomelo — ${result.released} reactions`
          : "A day passed on Pomelo",
        {
          description:
            result.released > 0
              ? `${result.replies} of them were replies. Metrics are updating.`
              : "Nothing was waiting to happen. Publish something first, then fast-forward.",
        },
      );
    },
    onError: (error: Error) =>
      toast.danger("Could not advance the clock", { description: error.message }),
  });

  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger>
        <Button
          size={size}
          variant="secondary"
          isPending={fastForward.isPending}
          onPress={() => fastForward.mutate()}
        >
          <ForwardIcon className="size-4" />
          Fast-forward a day
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-64">
        <p className="text-xs leading-relaxed">
          Advances Pomelo's clock by a day so a published post's audience reacts
          now instead of over the next 48 hours. Only affects the simulated
          network — real platforms keep real time.
        </p>
      </Tooltip.Content>
    </Tooltip>
  );
}
