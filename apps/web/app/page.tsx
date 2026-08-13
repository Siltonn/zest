import { Card, Chip } from "@heroui/react";

type HealthResponse = { status: string; mode: string; database: string };

async function fetchHealth(): Promise<HealthResponse | null> {
  const serverUrl = process.env.SERVER_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${serverUrl}/health`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const health = await fetchHealth();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <Chip color="warning" variant="soft" size="sm">
          M0 · skeleton
        </Chip>
        <h1 className="text-4xl font-semibold tracking-tight">Zest</h1>
        <p className="text-lg opacity-70">
          An open-source AI social media operations agent. It researches, drafts,
          schedules, publishes, replies, and learns — you approve until you trust it.
        </p>
      </div>

      <Card>
        <Card.Header>
          <Card.Title>Backend</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-row items-center gap-3">
          {health ? (
            <>
              <Chip color="success" variant="soft" size="sm">
                reachable
              </Chip>
              <span className="text-sm opacity-70">
                MODE={health.mode} · database={health.database}
              </span>
            </>
          ) : (
            <>
              <Chip color="danger" variant="soft" size="sm">
                unreachable
              </Chip>
              <span className="text-sm opacity-70">
                Start it with <code>docker compose up</code>
              </span>
            </>
          )}
        </Card.Content>
      </Card>
    </main>
  );
}
