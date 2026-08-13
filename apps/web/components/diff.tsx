"use client";

/**
 * A line-level diff for proposed memory rewrites.
 *
 * Approving a strategy rewrite means approving a whole document, and nobody
 * reads a whole document twice to spot what moved. Showing only the changed
 * lines is what makes the approval a real decision rather than a rubber stamp.
 */

type Line = { kind: "same" | "added" | "removed"; text: string };

export function diffLines(before: string, after: string): Line[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Longest common subsequence over lines — documents here are a page or two,
  // so the quadratic table is nothing.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}

/** Unchanged runs longer than this collapse to a divider. */
const CONTEXT = 2;

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  const changed = lines.filter((l) => l.kind !== "same").length;

  if (changed === 0) {
    return <p className="text-sm opacity-50">No change — the text is identical.</p>;
  }

  // Keep a couple of lines either side of each change; skip the rest.
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = index - CONTEXT; k <= index + CONTEXT; k++) keep.add(k);
  });

  const rendered: React.ReactNode[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {
      if (!skipping) {
        rendered.push(
          <div key={`gap-${index}`} className="px-3 py-1 text-xs opacity-30">
            ⋯
          </div>,
        );
        skipping = true;
      }
      return;
    }
    skipping = false;
    rendered.push(
      <div
        key={index}
        className={`px-3 py-0.5 font-mono text-xs leading-relaxed ${
          line.kind === "added"
            ? "bg-success/10 text-success-700 dark:text-success-400"
            : line.kind === "removed"
              ? "bg-danger/10 text-danger-700 line-through decoration-danger/40 dark:text-danger-400"
              : "opacity-55"
        }`}
      >
        <span className="mr-2 inline-block w-3 select-none opacity-50">
          {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
        </span>
        {line.text || " "}
      </div>,
    );
  });

  return (
    <div className="overflow-hidden rounded-lg border border-default-200/70">
      <div className="border-b border-default-200/70 bg-default-100/50 px-3 py-1.5 text-xs opacity-60">
        {changed} line{changed === 1 ? "" : "s"} changed
      </div>
      <div className="max-h-80 overflow-y-auto py-1">{rendered}</div>
    </div>
  );
}
