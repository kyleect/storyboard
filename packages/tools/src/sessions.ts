import { z } from "zod";
import {
  defineTool,
  HISTORY_PAGE_MAX,
  type ToolContext,
  type ToolOutput,
} from "@harness/core";

/*
 * Tools for the sessions this one continues (session rollover design, D17).
 * When a session's context fills, the work goes on in a new session, and the
 * old one stays searchable. Both tools only read, so they never ask; they are
 * offered only to a session that continues another.
 */

const hasEarlierSessions = (run: { hasEarlierSessions?: boolean }) =>
  run.hasEarlierSessions === true;

const fail = (error: string, reason: string): ToolOutput => ({
  data: { error },
  isError: true,
  details: { reason },
});

const noHistory = (ctx: ToolContext): ToolOutput | undefined =>
  ctx.history
    ? undefined
    : fail("This session does not continue an earlier one.", "rejected");

export const sessionsSearch = defineTool({
  name: "sessions_search",
  description:
    "Searches the earlier sessions this session was continued from, by keywords and by meaning. Use it for something said or done before the context was cleared: what the user asked for, a decision, a result. Returns messages with the session's title, the message id and an excerpt; use sessions_read with a message id to read around it. When hasMore is true, call again with a larger offset to see the next page.",
  input: z.object({
    query: z.string().min(1).describe("What to look for."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(HISTORY_PAGE_MAX)
      .optional()
      .describe("The most messages to return. Default 10."),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe("How many matches to skip, for the next page. Default 0."),
  }),
  approval: "never",
  group: "sessions",
  available: hasEarlierSessions,
  execute: async ({ query, limit, offset }, ctx) => {
    const history = ctx.history;
    if (!history) return noHistory(ctx) as ToolOutput;
    const found = await history.search({
      query,
      limit: limit ?? 10,
      offset: offset ?? 0,
      signal: ctx.signal,
    });
    return {
      data: {
        hits: found.hits.map((h) => ({
          session: h.sessionTitle,
          sessionId: h.sessionId,
          messageId: h.messageId,
          excerpt: h.excerpt,
          matched: h.matched,
        })),
        hasMore: found.hasMore,
        mode: found.mode,
        ...(found.notice ? { notice: found.notice } : {}),
      },
    };
  },
});

export const sessionsRead = defineTool({
  name: "sessions_read",
  description:
    "Reads messages of an earlier session around one message, as the conversation went: the user's messages, your replies (with the tools you called) and tool results. Take sessionId and messageId from sessions_search. Long messages are cut. To read further, call again with the first or last message id returned.",
  input: z.object({
    sessionId: z.string().min(1).describe("The session, from sessions_search."),
    messageId: z
      .string()
      .min(1)
      .describe("The message to centre the window on."),
    before: z
      .number()
      .int()
      .min(0)
      .max(HISTORY_PAGE_MAX)
      .optional()
      .describe("How many messages before it. Default 10."),
    after: z
      .number()
      .int()
      .min(0)
      .max(HISTORY_PAGE_MAX)
      .optional()
      .describe("How many messages after it. Default 10."),
  }),
  approval: "never",
  group: "sessions",
  available: hasEarlierSessions,
  execute: ({ sessionId, messageId, before, after }, ctx) => {
    const history = ctx.history;
    if (!history) return noHistory(ctx) as ToolOutput;
    const read = history.read({
      sessionId,
      messageId,
      before: before ?? 10,
      after: after ?? 10,
    });
    if ("error" in read) return fail(read.error, "not_found");
    return {
      data: {
        session: read.sessionTitle,
        sessionId: read.sessionId,
        messages: read.messages,
        hasBefore: read.hasBefore,
        hasAfter: read.hasAfter,
      },
    };
  },
});

export const sessionTools = [sessionsSearch, sessionsRead];
