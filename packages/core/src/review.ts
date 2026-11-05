import { z } from "zod";

/*
 * What an approval prompt shows of a tool's proposed changes, and what the
 * user picked (schemas and data design, decisions 31 to 35; plan P5). A
 * tool that can describe its changes declares `review`; others are asked
 * about as before, with their arguments.
 */

export const ChangeSchema = z.object({
  /** JSON Pointer to the field or list item; "" for the whole value. */
  path: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type ChangeRecord = z.infer<typeof ChangeSchema>;

/** One thing a call changes, such as one piece of data. */
export const ReviewItem = z.object({
  /** Names the item in a selection. */
  key: z.string(),
  /** What the prompt calls it, such as `Task "Draft scene 2"`. */
  label: z.string(),
  /** Undefined for something new. */
  before: z.unknown().optional(),
  after: z.unknown(),
  /** The changes the user can approve one by one (decision 32). */
  changes: z.array(ChangeSchema),
  /** Show `after` in full above the changes (decision 35b, for a create). */
  showValue: z.boolean().optional(),
  /** For a migration: how the schema changed, shown, not picked (31). */
  schema: z
    .object({
      fromVersion: z.number(),
      toVersion: z.number(),
      changes: z.array(ChangeSchema),
    })
    .optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const Review = z.object({ items: z.array(ReviewItem) });
export type Review = z.infer<typeof Review>;

/**
 * The paths the user approved, by item key. An item left out is not
 * applied at all.
 */
export const Selection = z.record(z.string(), z.array(z.string()));
export type Selection = z.infer<typeof Selection>;

/** Every change of every item: what Approve all applies. */
export const selectAll = (review: Review): Selection =>
  Object.fromEntries(
    review.items.map((i) => [i.key, i.changes.map((c) => c.path)]),
  );
