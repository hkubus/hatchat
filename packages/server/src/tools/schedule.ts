import type { Logger, Part, Plugin } from "@hat/core";
import { normalizeError } from "@hat/core";
import type { ScheduleRecord, Store } from "@hat/store-sqlite";
import { z } from "zod";
import { assertTimeZone, nextCronRun, parseCron } from "../cron.js";

const text = (value: string): Part => ({ type: "text", text: value });
const TICK_MS = 30_000;
const MAX_SCHEDULES = 50;

export interface SchedulerDeps {
  store: Store;
  logger: Logger;
  /** Start a turn for `prompt` in `sessionId` and resolve when it finishes. */
  runPrompt(sessionId: string, prompt: string): Promise<void>;
  /** Whether a turn is already running in the session (runs never pre-empt one). */
  isBusy(sessionId: string): boolean;
}

/** Compute the next run for a schedule, or null when it will never fire again. */
export function nextRunFor(schedule: Pick<ScheduleRecord, "cron" | "timezone" | "runAt">, after: number): number | null {
  if (schedule.cron) return nextCronRun(parseCron(schedule.cron), schedule.timezone, after);
  return schedule.runAt !== null && schedule.runAt > after ? schedule.runAt : null;
}

/**
 * Fires due schedules. Each run sends the prompt as a user message, either
 * into the schedule's own conversation or into a fresh one, so results show
 * up in the sidebar like any other chat.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = Date.now()): Promise<void> {
    for (const schedule of this.deps.store.dueSchedules(now)) {
      if (this.running.has(schedule.id)) continue;
      if (schedule.sessionId && this.deps.isBusy(schedule.sessionId)) continue;
      this.running.add(schedule.id);
      void this.fire(schedule, now).finally(() => this.running.delete(schedule.id));
    }
  }

  runNow(id: string): Promise<void> {
    const schedule = this.deps.store.getSchedule(id);
    if (!schedule) return Promise.reject(new Error(`no schedule ${id}`));
    return this.fire(schedule, Date.now(), false);
  }

  private async fire(schedule: ScheduleRecord, now: number, advance = true): Promise<void> {
    const { store, logger } = this.deps;
    let nextRunAt: number | null = schedule.nextRunAt;
    if (advance) {
      try {
        nextRunAt = nextRunFor(schedule, now);
      } catch {
        nextRunAt = null;
      }
    }
    let sessionId = schedule.sessionId;
    if (sessionId && !store.getSession(sessionId)) sessionId = null;
    let target = sessionId;
    if (!target) {
      target = store.createSession(schedule.model).id;
      // A user-owned title, so turn titling leaves the schedule's name alone.
      store.setSessionTitle(target, `${schedule.title} · ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`);
    }
    // Advance first, so a crash mid-run can't make the schedule fire in a loop.
    store.markScheduleRun(schedule.id, { at: now, sessionId: target, error: null, nextRunAt });
    logger.info(`schedule ${schedule.id} (${schedule.title}) firing into ${target}`);
    try {
      await this.deps.runPrompt(target, `[Scheduled task "${schedule.title}"]\n\n${schedule.prompt}`);
    } catch (error) {
      const message = normalizeError(error, "schedule_failed").message;
      logger.warn(`schedule ${schedule.id} failed`, message);
      store.markScheduleRun(schedule.id, { at: now, sessionId: target, error: message, nextRunAt });
    }
  }
}

function describeSchedule(schedule: ScheduleRecord): string {
  const when = schedule.cron ? `cron "${schedule.cron}" (${schedule.timezone})` : `once`;
  const next = schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : "never";
  const where = schedule.sessionId ? "this conversation" : "a new conversation each run";
  return `${schedule.id}  "${schedule.title}"  ${when}, next ${next}, into ${where}${schedule.enabled ? "" : " [disabled]"}${
    schedule.lastError ? ` (last error: ${schedule.lastError})` : ""
  }`;
}

const createSchema = z.object({
  title: z.string().min(1).max(80).describe("Short name, e.g. \"Morning news digest\"."),
  prompt: z
    .string()
    .min(1)
    .describe("The instruction to run each time, written to stand alone (it runs without this chat's context unless target is this_conversation)."),
  cron: z
    .string()
    .optional()
    .describe('Recurring: 5-field cron "minute hour day month weekday", e.g. "0 8 * * 1-5" for 08:00 on weekdays. Also @daily, @hourly, @weekly.'),
  run_at: z
    .string()
    .optional()
    .describe("One-shot: ISO 8601 date-time with offset, e.g. 2026-10-01T15:00:00+02:00."),
  timezone: z
    .string()
    .optional()
    .describe('IANA time zone the cron is read in, e.g. "Europe/Berlin" (default UTC). Ask the user if unsure.'),
  target: z
    .enum(["new_conversation", "this_conversation"])
    .optional()
    .describe("Where results go: a fresh conversation per run (default) or appended here."),
});

export function createSchedulerPlugin(deps: { store: Store; scheduler: Scheduler; modelFor(sessionId: string): string }): Plugin {
  const { store } = deps;
  return {
    id: "scheduler",
    name: "Scheduled tasks",
    version: "0.1.0",
    description: "Let the assistant schedule prompts to run later or on a recurring cron.",
    activate(ctx) {
      ctx.register.tool({
        name: "schedule_create",
        description:
          "Schedule a prompt to run later, once (run_at) or on a recurring cron — e.g. a daily " +
          "digest or a reminder. Each run is a normal assistant turn with all tools, and its " +
          "result appears as a conversation in the user's sidebar.",
        schema: createSchema,
        requiresApproval: true,
        async execute(raw, toolCtx): Promise<Part[]> {
          const args = createSchema.parse(raw);
          if (Boolean(args.cron) === Boolean(args.run_at)) throw new Error("pass exactly one of cron or run_at");
          if (store.listSchedules().filter((s) => s.enabled).length >= MAX_SCHEDULES) {
            throw new Error(`there are already ${MAX_SCHEDULES} active schedules; delete some first`);
          }
          const timezone = args.timezone?.trim() || "UTC";
          assertTimeZone(timezone);
          let runAt: number | null = null;
          if (args.cron) {
            parseCron(args.cron);
          } else {
            runAt = Date.parse(args.run_at!);
            if (Number.isNaN(runAt)) throw new Error(`could not parse run_at "${args.run_at}"`);
            if (runAt <= Date.now()) throw new Error("run_at is in the past");
          }
          const draft = { cron: args.cron?.trim() ?? null, timezone, runAt };
          const nextRunAt = nextRunFor(draft, Date.now());
          if (nextRunAt === null) throw new Error("that schedule never fires within the next year");
          const schedule = store.createSchedule({
            ...draft,
            title: args.title.trim(),
            prompt: args.prompt,
            sessionId: args.target === "this_conversation" ? toolCtx.sessionId : null,
            model: deps.modelFor(toolCtx.sessionId),
            nextRunAt,
          });
          return [text(`Scheduled. ${describeSchedule(schedule)}`)];
        },
      });
      ctx.register.tool({
        name: "schedule_list",
        description: "List the user's scheduled tasks with their next run times.",
        schema: z.object({}),
        requiresApproval: false,
        async execute(): Promise<Part[]> {
          const schedules = store.listSchedules();
          return [text(schedules.length ? schedules.map(describeSchedule).join("\n") : "No scheduled tasks.")];
        },
      });
      ctx.register.tool({
        name: "schedule_delete",
        description: "Delete a scheduled task by id.",
        schema: z.object({ id: z.string() }),
        requiresApproval: false,
        async execute(raw): Promise<Part[]> {
          const { id } = z.object({ id: z.string() }).parse(raw);
          if (!store.deleteSchedule(id)) throw new Error(`no schedule with id ${id}`);
          return [text(`Deleted schedule ${id}.`)];
        },
      });
    },
  };
}
