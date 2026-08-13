import { blueskyConnector } from "./bluesky.ts";
import { mastodonConnector } from "./mastodon.ts";
import { pomeloConnector } from "./pomelo.ts";
import type { Connector, ConnectorMeta } from "./types.ts";

/**
 * The connector registry. Publishing looks up a connector by id rather than
 * branching on platform — adding a network is registering an object here, and
 * no dispatch code changes.
 */

const connectors = new Map<string, Connector>([
  [pomeloConnector.meta.id, pomeloConnector],
  [blueskyConnector.meta.id, blueskyConnector],
  [mastodonConnector.meta.id, mastodonConnector],
]);

export function getConnector(id: string): Connector {
  const connector = connectors.get(id);
  if (!connector) {
    throw new Error(
      `Unknown connector "${id}". Registered: ${[...connectors.keys()].join(", ")}`,
    );
  }
  return connector;
}

export function tryGetConnector(id: string): Connector | undefined {
  return connectors.get(id);
}

export function listConnectors(): Connector[] {
  return [...connectors.values()];
}

/**
 * Platform constraints in one place. The composer's character counter, the
 * pre-publish validation and the agent's system prompt all read this, so the
 * three can never disagree about a limit.
 */
export function listConnectorMeta(): ConnectorMeta[] {
  return listConnectors().map((c) => c.meta);
}

export function registerConnector(connector: Connector): void {
  connectors.set(connector.meta.id, connector);
}
