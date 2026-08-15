"use client";

import { Button, Modal, Spinner } from "@heroui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";

export type MediaAsset = {
  id: string;
  url: string;
  filename: string;
  bytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
};

type MediaPage = { assets: MediaAsset[]; nextCursor: string | null };

/**
 * Reuse an image already uploaded.
 *
 * Uploading the same picture twice was the only option before, which quietly
 * doubled the disk for every logo or screenshot appearing in more than one
 * post. Newest-first and cursor-paged, because this list only grows at the head.
 */
export function MediaPicker({
  onPick,
  attached,
  isDisabled,
}: {
  onPick: (asset: MediaAsset) => void;
  /** URLs already on the draft, so the same image cannot be added twice. */
  attached: string[];
  isDisabled?: boolean;
}) {
  const [isOpen, setOpen] = useState(false);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["media"],
      queryFn: ({ pageParam }) =>
        api.get<MediaPage>(`/media${pageParam ? `?before=${pageParam}` : ""}`),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    });

  const assets = data?.pages.flatMap((page) => page.assets) ?? [];

  // Controlled rather than letting each tile be a `Modal.CloseTrigger`: that
  // component *is* a button, so a tile nested inside one is a button within a
  // button — invalid markup, and react-aria threw on it rather than rendering.
  return (
    <Modal isOpen={isOpen} onOpenChange={setOpen}>
      <Modal.Trigger>
        <Button size="sm" variant="tertiary" isDisabled={isDisabled}>
          Choose existing
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="w-full max-w-2xl">
            <Modal.Header>
              <Modal.Heading>Your images</Modal.Heading>
            </Modal.Header>

            <Modal.Body className="max-h-[60vh] overflow-y-auto">
              {isLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner />
                </div>
              ) : assets.length === 0 ? (
                <p className="py-10 text-center text-sm opacity-55">
                  Nothing uploaded yet. Add an image to a post and it will appear
                  here.
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {assets.map((asset) => {
                    const already = attached.includes(asset.url);
                    return (
                        <button
                          key={asset.id}
                          type="button"
                          disabled={already}
                          onClick={() => {
                            onPick(asset);
                            setOpen(false);
                          }}
                          title={asset.filename}
                          className={[
                            "group relative w-full overflow-hidden rounded-lg border border-default-200 text-left",
                            "transition-[transform,border-color] duration-150 ease-out",
                            already
                              ? "cursor-not-allowed opacity-40"
                              : "cursor-pointer hover:scale-[1.02] hover:border-accent active:scale-[0.99]",
                          ].join(" ")}
                        >
                          <img
                            src={asset.url}
                            alt={asset.filename}
                            className="aspect-square w-full object-cover"
                          />
                          <span className="block truncate px-1.5 py-1 text-[11px] opacity-60">
                            {asset.width && asset.height
                              ? `${asset.width}×${asset.height}`
                              : relativeTime(asset.createdAt)}
                          </span>
                          {already && (
                            <span className="absolute inset-x-0 top-1/3 text-center text-xs font-medium">
                              added
                            </span>
                          )}
                        </button>
                    );
                  })}
                </div>
              )}

              {hasNextPage && (
                <div className="flex justify-center pt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => void fetchNextPage()}
                    isPending={isFetchingNextPage}
                  >
                    Load older
                  </Button>
                </div>
              )}
            </Modal.Body>

            <Modal.Footer>
              <Modal.CloseTrigger>
                <Button variant="tertiary">Close</Button>
              </Modal.CloseTrigger>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
