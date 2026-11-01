import { z } from "zod";
import { defineTool } from "@harness/core";

/*
 * Example tools: the current date and time where the backend runs, in its
 * time zone.
 */

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n: number) => String(n).padStart(2, "0");

export const currentDate = defineTool({
  name: "current_date",
  description:
    "Returns today's date (YYYY-MM-DD) in the user's local time zone.",
  input: z.object({}),
  approval: "never",
  execute: () => {
    const now = new Date();
    return {
      data: {
        date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        timeZone: timeZone(),
      },
    };
  },
});

export const currentTime = defineTool({
  name: "current_time",
  description:
    "Returns the current time (HH:MM:SS, 24-hour) in the user's local time zone.",
  input: z.object({}),
  approval: "never",
  execute: () => {
    const now = new Date();
    return {
      data: {
        time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        timeZone: timeZone(),
      },
    };
  },
});
