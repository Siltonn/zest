"use client";

import { Avatar, Button, Card, Chip, Skeleton, TextArea } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { api, type InboxItem } from "@/lib/api";
import { ChatIcon, ComposeIcon, ZestMark } from "@/components/icons";
import { relativeTime } from "@/lib/format";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: { tool: string; summary?: string }[];
  proposals: { kind: "post" | "reply"; id: string }[];
  agentRunId: string | null;
  createdAt: string;
};

type Conversation = { id: string; title: string; updatedAt: string };

type SendResult = {
  conversation: Conversation;
  userMessage: Message;
  reply: Message;
};

/**
 * The operator's direct line to the agent.
 *
 * Same tools and the same autonomy guard as the scheduled runs — which is the
 * point: asking for a draft here does not quietly publish one. Anything the
 * agent proposes comes back attached to its message and can be approved right
 * there, so reviewing does not mean leaving the conversation.
 */
const STARTERS = [
  "Plan next week for both accounts.",
  "Why did the build-time post do better than the others?",
  "Draft something for the founder account about shipping on Fridays.",
  "What is waiting in my approval queue?",
];

export default function ChatPage() {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const { data: history = [] } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get<Conversation[]>("/chat"),
  });

  const { data: thread } = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () =>
      api.get<{ conversation: Conversation; messages: Message[] }>(
        `/chat/${conversationId}`,
      ),
    enabled: Boolean(conversationId),
  });

  const send = useMutation({
    mutationFn: (message: string) =>
      api.post<SendResult>("/chat", {
        message,
        ...(conversationId ? { conversationId } : {}),
      }),
    onSuccess: (result) => {
      setPending(null);
      setConversationId(result.conversation.id);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({
        queryKey: ["conversation", result.conversation.id],
      });
      // A proposal made in chat also lands in the inbox badge.
      void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
    },
    onError: () => setPending(null),
  });

  const messages = thread?.messages ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  const submit = (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || send.isPending) return;
    setInput("");
    setPending(message);
    send.mutate(message);
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-9rem)] max-w-none gap-5">
      <aside className="hidden w-60 shrink-0 flex-col lg:flex">
        <Button
          variant="secondary"
          className="mb-3 w-full"
          onPress={() => {
            setConversationId(null);
            setInput("");
          }}
        >
          <ComposeIcon className="size-4" />
          New conversation
        </Button>

        <div className="mb-2 px-1 text-xs font-medium opacity-55">Recent</div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {history.length === 0 && (
            <p className="px-1 text-xs opacity-55">Nothing yet.</p>
          )}
          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setConversationId(item.id)}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                conversationId === item.id
                  ? "bg-default-200/70 font-medium"
                  : "opacity-75 hover:bg-default-100 hover:opacity-100"
              }`}
            >
              <div className="truncate">{item.title}</div>
              <div className="text-xs opacity-55">{relativeTime(item.updatedAt)}</div>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 pb-6">
            {messages.length === 0 && !pending ? (
              <Welcome onPick={submit} />
            ) : (
              messages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))
            )}

            {pending && (
              <>
                <MessageRow
                  message={{
                    id: "pending-user",
                    role: "user",
                    content: pending,
                    toolCalls: [],
                    proposals: [],
                    agentRunId: null,
                    createdAt: new Date().toISOString(),
                  }}
                />
                <Thinking />
              </>
            )}

            {send.isError && (
              <p className="text-sm text-danger">{(send.error as Error).message}</p>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl pt-2">
          <div className="rounded-2xl border border-default-200/60 bg-default-50/40 p-2">
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
              placeholder="Ask for a plan, a draft, or an explanation…"
              className="border-0 bg-transparent"
            />
            <div className="flex items-center justify-between px-1 pt-1">
              <span className="text-xs opacity-55">
                Anything it proposes still needs your approval
              </span>
              <Button
                size="sm"
                onPress={() => submit()}
                isPending={send.isPending}
                isDisabled={!input.trim()}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="pt-10">
      <div className="mb-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-foreground text-background">
          <ZestMark className="size-6" />
        </div>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">
          What should we work on?
        </h1>
        <p className="mt-1 text-sm opacity-55">
          The agent can research, draft, explain, and propose. It uses the same tools
          as the scheduled runs, so nothing here bypasses your review.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            type="button"
            onClick={() => onPick(starter)}
            className="rounded-xl border border-default-200/60 p-3 text-left text-sm transition-colors hover:border-default-300 hover:bg-default-100/60"
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Messages are full-width rows rather than bubbles: an answer here can carry a
 * tool trace and a proposal to approve, and none of that fits in a chat bubble.
 */
function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div className="flex gap-3">
      <Avatar className="mt-0.5 size-7 shrink-0">
        <Avatar.Fallback
          className={`text-xs ${isUser ? "" : "bg-foreground text-background"}`}
        >
          {isUser ? "You" : <ZestMark className="size-4" />}
        </Avatar.Fallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="mb-1 text-sm font-medium">{isUser ? "You" : "Zest"}</div>
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
          {message.content}
        </p>

        {message.toolCalls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.toolCalls.map((call, index) => (
              <Chip key={`${call.tool}-${index}`} size="sm" variant="soft">
                {call.tool.replace(/_/g, " ")}
              </Chip>
            ))}
          </div>
        )}

        {message.proposals.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} />
        ))}

        {message.agentRunId && (
          <a
            href={`/team?run=${message.agentRunId}`}
            className="mt-2 inline-block text-xs underline opacity-55 hover:opacity-70"
          >
            See the full run
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Approve or reject without leaving the conversation. This is the whole reason
 * chat is worth having in an approval-gated product: the agent proposes, and
 * the decision happens in the same place.
 */
function ProposalCard({
  proposal,
}: {
  proposal: { kind: "post" | "reply"; id: string };
}) {
  const queryClient = useQueryClient();
  const [decided, setDecided] = useState<"approved" | "rejected" | null>(null);

  const { data: item } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api.get<InboxItem[]>("/inbox"),
    select: (items) => items.find((i) => i.id === proposal.id),
  });

  const act = useMutation({
    mutationFn: (action: "approve" | "reject") =>
      api.post(
        proposal.kind === "reply"
          ? `/replies/${proposal.id}/${action}`
          : `/posts/${proposal.id}/${action}`,
      ),
    onSuccess: (_result, action) => {
      setDecided(action === "approve" ? "approved" : "rejected");
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox-count"] });
      void queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
  });

  // Already handled elsewhere — say so rather than offering a dead button.
  if (!item && !decided) return null;

  return (
    <Card className="mt-3 border-l-4 border-l-warning">
      <Card.Content className="py-3">
        <div className="mb-1.5 flex items-center gap-2">
          <Chip size="sm" variant="soft" color="warning">
            {proposal.kind === "reply" ? "Reply drafted" : "Post proposed"}
          </Chip>
          {item?.accountHandle && (
            <span className="text-xs opacity-50">@{item.accountHandle}</span>
          )}
        </div>

        {item && (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{item.body}</p>
        )}

        {decided ? (
          <p className="mt-2 text-sm opacity-60">
            {decided === "approved" ? "Approved and queued." : "Rejected."}
          </p>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onPress={() => act.mutate("approve")}
              isPending={act.isPending}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => act.mutate("reject")}
              isPending={act.isPending}
            >
              Reject
            </Button>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function Thinking() {
  return (
    <div className="flex gap-3">
      <Avatar className="mt-0.5 size-7 shrink-0">
        <Avatar.Fallback className="bg-foreground text-background">
          <ZestMark className="size-4" />
        </Avatar.Fallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-2 pt-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}
