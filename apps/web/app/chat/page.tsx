"use client";

import { Button, Card, Spinner, TextArea } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { api } from "@/lib/api";

type Turn = { role: "you" | "agent"; text: string; runId?: string };

/**
 * Direct line to the agent. Same tools and the same autonomy guard as the
 * scheduled runs — asking it to draft something here still produces a proposal
 * in the inbox rather than an unreviewed post.
 */
export default function ChatPage() {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");

  const send = useMutation({
    mutationFn: (message: string) =>
      api.post<{ runId: string; reply: string }>("/agent/chat", { message }),
    onSuccess: (result) => {
      setTurns((t) => [...t, { role: "agent", text: result.reply, runId: result.runId }]);
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
    },
    onError: (error: Error) => {
      setTurns((t) => [...t, { role: "agent", text: `⚠ ${error.message}` }]);
    },
  });

  const submit = () => {
    const message = input.trim();
    if (!message) return;
    setTurns((t) => [...t, { role: "you", text: message }]);
    setInput("");
    send.mutate(message);
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-6rem)] max-w-3xl flex-col">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Chat</h1>
        <p className="text-sm opacity-60">
          Ask for a plan, a draft, or an explanation. Anything it writes still goes
          through the inbox.
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
        {turns.length === 0 && (
          <Card>
            <Card.Content className="space-y-2 py-6 text-sm opacity-70">
              <p className="font-medium opacity-100">Things worth asking:</p>
              <ul className="list-inside list-disc space-y-1">
                <li>Plan next week for both accounts.</li>
                <li>Why did the build-time post do better than the others?</li>
                <li>Draft something for the founder account about shipping on Fridays.</li>
                <li>What is in my approval queue right now?</li>
              </ul>
            </Card.Content>
          </Card>
        )}

        {turns.map((turn, index) => (
          <div
            key={index}
            className={turn.role === "you" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                turn.role === "you"
                  ? "bg-default-200/70"
                  : "border border-default-200/60"
              }`}
            >
              <p className="whitespace-pre-wrap">{turn.text}</p>
              {turn.runId && (
                <a
                  href={`/team?run=${turn.runId}`}
                  className="mt-1.5 inline-block text-xs underline opacity-40"
                >
                  see what it did
                </a>
              )}
            </div>
          </div>
        ))}

        {send.isPending && (
          <div className="flex items-center gap-2 text-sm opacity-50">
            <Spinner size="sm" /> thinking…
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-default-200/60 pt-3">
        <TextArea
          value={input}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            // Enter sends; shift+enter is a newline, as everywhere else.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="Ask the agent something…"
          className="flex-1"
        />
        <Button onPress={submit} isPending={send.isPending} isDisabled={!input.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}
