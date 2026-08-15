// Mark-and-sweep over a pnpm virtual store, for the server image.
//
// The problem it solves: `pnpm install --frozen-lockfile` hydrates every package
// in the lockfile, and a lockfile describes the whole workspace. Narrowing the
// install does not help — `--filter` chooses which projects get linked, not
// which packages get unpacked, and a store built from eight manifests still
// contained all 551. So a NestJS image arrived carrying Next.js.
//
// Two passes.
//
// First, sever optional peer dependencies the server provably does not use.
// better-auth declares `next` optional-peer for its Next.js route handler; pnpm
// sees Next in the workspace (apps/web has it) and links it, and that link plus
// its native SWC binary is 281 MB of an image that never calls it. Severing is
// only safe while nothing imports those entry points, so the caller is expected
// to assert that against the built output — see the Dockerfile.
//
// Then mark-and-sweep. Every dependency edge in `.pnpm` is a symlink, so the set
// a process can require is exactly the set reachable from the deployed package's
// links. Anything unreachable is unreferenced by construction: this cannot
// orphan a module some code path would have loaded, because such a module would
// have had a link to follow.
//
// Usage: node prune-store.mjs <deploy-dir> [optional-peer-to-sever ...]
import { readdir, readlink, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const [, , target = "/prod", ...sever] = process.argv;
const root = resolve(target);
const store = join(root, "node_modules", ".pnpm");

/** Every symlink under a node_modules directory, resolved to its real path. */
async function linksIn(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Scoped packages nest one level deeper: @scope/name.
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      out.push(...(await linksIn(path)));
    } else if (entry.isSymbolicLink()) {
      out.push(resolve(dir, await readlink(path)));
    }
  }
  return out;
}

/** The `.pnpm/<name>@<version>` directory a resolved path belongs to, if any. */
function storeEntryOf(path) {
  if (!path.startsWith(store)) return null;
  const name = path.slice(store.length + 1).split("/")[0];
  return name || null;
}

async function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    let entries;
    try {
      entries = await readdir(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(child);
      else total += (await stat(child).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

// ── Pass one: sever the named optional peers, wherever they are linked ───────
let severed = 0;
for (const dir of await readdir(store).catch(() => [])) {
  for (const name of sever) {
    const link = join(store, dir, "node_modules", name);
    try {
      await rm(link, { recursive: true, force: true });
      severed += 1;
    } catch {
      /* not linked here */
    }
  }
}
for (const name of sever) {
  await rm(join(root, "node_modules", name), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

// ── Pass two: keep only what the deployed package can still reach ────────────
const reachable = new Set();
const queue = await linksIn(join(root, "node_modules"));

while (queue.length > 0) {
  const entry = storeEntryOf(queue.pop());
  if (!entry || reachable.has(entry)) continue;
  reachable.add(entry);
  queue.push(...(await linksIn(join(store, entry, "node_modules"))));
}

let removed = 0;
let bytes = 0;
for (const entry of await readdir(store).catch(() => [])) {
  if (reachable.has(entry) || entry.startsWith("node_modules")) continue;
  const path = join(store, entry);
  bytes += await sizeOf(path);
  await rm(path, { recursive: true, force: true });
  removed += 1;
}

console.log(
  `severed ${severed} optional-peer links; ` +
    `removed ${removed} unreachable packages (${(bytes / 1024 ** 2).toFixed(0)} MB); ` +
    `kept ${reachable.size}`,
);
