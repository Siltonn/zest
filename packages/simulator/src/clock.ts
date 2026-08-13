import { eq, schema, type Database } from "@zest/db";

/**
 * The simulated clock.
 *
 * Pomelo runs on its own time so a demo can watch a day of engagement unfold in
 * seconds. Real platforms ignore this entirely — they always use wall-clock
 * time. Keeping the two separate means "fast-forward" is a Pomelo feature, not
 * a global hack that would corrupt real scheduling.
 */

export type SimClock = {
  workspaceId: string;
  simNow: Date;
  multiplier: number;
};

export async function readClock(
  db: Database,
  workspaceId: string,
): Promise<SimClock> {
  const [workspace] = await db
    .select({
      simClockAt: schema.workspaces.simClockAt,
      demoClockMultiplier: schema.workspaces.demoClockMultiplier,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));

  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

  return {
    workspaceId,
    simNow: workspace.simClockAt,
    multiplier: workspace.demoClockMultiplier,
  };
}

/**
 * Advances simulated time. Called by the tick job with the real elapsed
 * interval (multiplied), and by the "fast-forward a day" button with 24 hours.
 */
export async function advanceClock(
  db: Database,
  workspaceId: string,
  byMs: number,
): Promise<SimClock> {
  const clock = await readClock(db, workspaceId);
  const simNow = new Date(clock.simNow.getTime() + byMs);

  await db
    .update(schema.workspaces)
    .set({ simClockAt: simNow })
    .where(eq(schema.workspaces.id, workspaceId));

  return { ...clock, simNow };
}

export const ONE_SIM_DAY = 86_400_000;

/** How far to move the clock on a normal tick, given real elapsed time. */
export function tickAmount(clock: SimClock, realElapsedMs: number): number {
  return realElapsedMs * Math.max(clock.multiplier, 1);
}

/** Keeps the simulated clock in step with reality when demo mode is off. */
export async function syncToRealTime(
  db: Database,
  workspaceId: string,
): Promise<SimClock> {
  const now = new Date();
  await db
    .update(schema.workspaces)
    .set({ simClockAt: now })
    .where(eq(schema.workspaces.id, workspaceId));
  const clock = await readClock(db, workspaceId);
  return { ...clock, simNow: now };
}
