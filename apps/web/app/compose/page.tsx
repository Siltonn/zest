"use client";

import { Button, Card, Chip, Spinner, TextArea, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import { api, type Account } from "@/lib/api";
import { DateTimePicker } from "@/components/datetime-picker";
import { AccountSwitcher } from "@/components/account-switcher";
import { MediaPicker } from "@/components/media-picker";

/**
 * Writing by hand.
 *
 * The character counter reads the connector's own metadata — the same source
 * the agent's prompt and the pre-publish validation use — so the number here
 * can never disagree with what the platform will accept.
 */
export default function ComposePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [media, setMedia] = useState<{ url: string; altText?: string }[]>([]);
  const [thread, setThread] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<Account[]>("/accounts"),
  });

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  // Threads only where the platform can chain them; elsewhere the button is
  // absent rather than disabled-with-an-excuse.
  const supportsThreads = Boolean(account?.platform?.features.includes("threads"));
  const limit = account?.platform?.charLimit ?? 280;
  const length = [...text].length;
  const over = length > limit;

  // Keeps one step of undo: polish replaces the draft wholesale, and "that was
  // worse" needs a way back that does not depend on the browser's undo stack.
  const [beforePolish, setBeforePolish] = useState<string | null>(null);

  const polish = useMutation({
    mutationFn: () =>
      api.post<{ text: string }>("/compose/polish", {
        accountId: account?.id,
        text,
      }),
    onSuccess: (result) => {
      setBeforePolish(text);
      setText(result.text);
      toast.success(`Polished against @${account?.handle}'s voice`, {
        description: "Your point, their voice. Undo below if it lost something.",
      });
    },
    onError: (error: Error) =>
      toast.danger("Could not polish it", { description: error.message }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post("/posts", {
        accountId: account?.id,
        text,
        media,
        ...(supportsThreads && thread.filter((part) => part.trim()).length
          ? { thread: thread.filter((part) => part.trim()) }
          : {}),
        ...(when ? { scheduledAt: when } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["posts"] });
      router.push("/calendar");
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Compose</h1>
        <p className="text-sm opacity-60">
          Write it yourself. Goes straight to the queue — no approval needed for your
          own words.
        </p>
      </header>

      {accounts.length > 0 && account && (
        <AccountSwitcher
          value={account.id}
          onChange={(id) => id && setAccountId(id)}
        />
      )}

      <Card>
        <Card.Content className="space-y-3 pt-4">
          <TextArea
            value={text}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
            rows={7}
            placeholder={`What should @${account?.handle ?? "…"} say?`}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => polish.mutate()}
              isPending={polish.isPending}
              isDisabled={!text.trim() || !account}
            >
              Polish with the agent
            </Button>
            {beforePolish !== null && (
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => {
                  setText(beforePolish);
                  setBeforePolish(null);
                }}
              >
                Undo polish
              </Button>
            )}
            <span className="text-xs opacity-55">
              Rewrites your draft in this account’s voice — your point stays yours.
            </span>
          </div>

          {thread.map((part, index) => {
            const partLength = [...part].length;
            const partOver = partLength > limit;
            return (
              <div key={index} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium opacity-50">
                    Part {index + 2}
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs ${partOver ? "text-danger" : "opacity-55"}`}
                    >
                      {partLength}/{limit}
                    </span>
                    <Button
                      size="sm"
                      variant="tertiary"
                      onPress={() =>
                        setThread((parts) => parts.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <TextArea
                  value={part}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                    setThread((parts) =>
                      parts.map((item, i) => (i === index ? e.target.value : item)),
                    )
                  }
                  rows={3}
                  placeholder={`Part ${index + 2} — published as a reply to part ${index + 1}`}
                />
              </div>
            );
          })}

          {supportsThreads && (thread.length > 0 || length > limit * 0.7) && (
              <Button
                size="sm"
                variant="tertiary"
                onPress={() => setThread((parts) => [...parts, ""])}
              >
                Add a thread part
              </Button>
            )}

          {media.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {media.map((item, index) => (
                <div key={item.url} className="relative">
                  <img
                    src={item.url}
                    alt=""
                    className="size-20 rounded-lg object-cover"
                  />
                  <button
                    onClick={() => setMedia((m) => m.filter((_, i) => i !== index))}
                    className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-default-800 text-xs text-white"
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setUploading(true);
              try {
                const form = new FormData();
                form.append("file", file);
                // Not api.post: this is multipart, so no JSON content type.
                const res = await fetch("/api/v1/media", {
                  method: "POST",
                  body: form,
                  credentials: "include",
                });
                if (res.ok) {
                  const { url } = (await res.json()) as { url: string };
                  setMedia((m) => [...m, { url }]);
                  // The picker's list is now stale by exactly this image.
                  void queryClient.invalidateQueries({ queryKey: ["media"] });
                }
              } finally {
                setUploading(false);
                if (fileInput.current) fileInput.current.value = "";
              }
            }}
          />

          <div className="flex items-center justify-between text-sm">
            <span className={over ? "font-medium text-danger" : "opacity-50"}>
              {length} / {limit}
              {over && ` — ${length - limit} over`}
            </span>
            <div className="flex items-center gap-2">
              {(account?.platform?.maxImages ?? 0) > 0 && (
                <>
                  <MediaPicker
                    attached={media.map((item) => item.url)}
                    isDisabled={media.length >= (account?.platform?.maxImages ?? 4)}
                    onPick={(asset) =>
                      setMedia((m) => [...m, { url: asset.url }])
                    }
                  />
                  <Button
                    size="sm"
                    variant="tertiary"
                    isPending={uploading}
                    isDisabled={media.length >= (account?.platform?.maxImages ?? 4)}
                    onPress={() => fileInput.current?.click()}
                  >
                    Upload
                  </Button>
                </>
              )}
              <DateTimePicker value={when} onChange={setWhen} />
            </div>
          </div>
        </Card.Content>
        <Card.Footer className="flex gap-2">
          <Button
            onPress={() => create.mutate()}
            isPending={create.isPending}
            isDisabled={over || text.trim().length === 0 || !account}
          >
            {when ? "Schedule" : "Save to queue"}
          </Button>
          {create.isError && (
            <span className="self-center text-sm text-danger">
              {(create.error as Error).message}
            </span>
          )}
        </Card.Footer>
      </Card>

      {/* A rough preview: enough to catch an awkward line break before it ships. */}
      {text.trim() && account && (
        <Card>
          <Card.Header>
            <Card.Title className="text-sm">
              Preview · {account.platform?.name}
            </Card.Title>
          </Card.Header>
          <Card.Content>
            <div className="flex gap-3">
              <div className="size-9 shrink-0 rounded-full bg-default-200" />
              <div className="min-w-0">
                <div className="text-sm">
                  <span className="font-medium">{account.displayName}</span>{" "}
                  <span className="opacity-55">@{account.handle}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed">
                  {text}
                </p>
              </div>
            </div>
          </Card.Content>
        </Card>
      )}
    </div>
  );
}
