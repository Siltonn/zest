import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { simEventKindEnum } from "./enums.js";

/**
 * Pomelo is a real (if small) social network that ships inside Zest: its own
 * tables, its own REST API, its own feed. The mock connector talks to it over
 * HTTP exactly like a production connector talks to Bluesky, so the offline
 * demo exercises the same code path a real integration would.
 */

export type PersonaConfig = {
  archetype:
    | "enthusiast"
    | "skeptic"
    | "lurker"
    | "question_asker"
    | "meme_poster"
    | "industry_peer";
  interests: string[];
  tone: string;
  /** 0..1 — how readily this persona engages with a matching post. */
  propensity: number;
  /** Local hours [start, end) during which the persona is awake. */
  activeHours: [number, number];
};

export const pomeloUsers = pgTable(
  "pomelo_users",
  {
    id: uuid().primaryKey().defaultRandom(),
    handle: text().notNull().unique(),
    displayName: text().notNull(),
    avatarUrl: text().notNull(),
    bio: text(),
    /** Personas are simulated residents; non-personas are Zest-owned accounts. */
    isPersona: boolean().notNull().default(true),
    personaConfig: jsonb().$type<PersonaConfig>(),
    followerCount: integer().notNull().default(0),
    apiKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pomelo_users_persona_idx").on(t.isPersona)],
);

export const pomeloPosts = pgTable(
  "pomelo_posts",
  {
    id: uuid().primaryKey().defaultRandom(),
    authorId: uuid()
      .notNull()
      .references(() => pomeloUsers.id, { onDelete: "cascade" }),
    text: text().notNull(),
    media: jsonb().$type<{ url: string; altText?: string }[]>().notNull().default([]),
    likeCount: integer().notNull().default(0),
    repostCount: integer().notNull().default(0),
    replyCount: integer().notNull().default(0),
    impressions: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pomelo_posts_author_idx").on(t.authorId, t.createdAt)],
);

export const pomeloReplies = pgTable(
  "pomelo_replies",
  {
    id: uuid().primaryKey().defaultRandom(),
    postId: uuid()
      .notNull()
      .references(() => pomeloPosts.id, { onDelete: "cascade" }),
    authorId: uuid()
      .notNull()
      .references(() => pomeloUsers.id, { onDelete: "cascade" }),
    text: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pomelo_replies_post_idx").on(t.postId, t.createdAt)],
);

export const pomeloFollows = pgTable(
  "pomelo_follows",
  {
    followerId: uuid()
      .notNull()
      .references(() => pomeloUsers.id, { onDelete: "cascade" }),
    followeeId: uuid()
      .notNull()
      .references(() => pomeloUsers.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followeeId] })],
);

export const pomeloTrends = pgTable("pomelo_trends", {
  id: uuid().primaryKey().defaultRandom(),
  topic: text().notNull(),
  /** Rises and falls as the simulated clock advances. */
  momentum: integer().notNull().default(50),
  dayIndex: integer().notNull().default(0),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Engagement is pre-computed at publish time as a schedule of discrete events
 * along a decay curve, then released as simulated time passes. That is what
 * makes "fast-forward one day" produce a believable burst instead of a jump.
 */
export const simEvents = pgTable(
  "sim_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    postId: uuid()
      .notNull()
      .references(() => pomeloPosts.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => pomeloUsers.id, { onDelete: "cascade" }),
    kind: simEventKindEnum().notNull(),
    payload: jsonb().$type<{ text?: string; count?: number }>(),
    fireAtSim: timestamp({ withTimezone: true }).notNull(),
    fired: boolean().notNull().default(false),
  },
  (t) => [index("sim_events_due_idx").on(t.fired, t.fireAtSim)],
);
