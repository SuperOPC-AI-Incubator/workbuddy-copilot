import type { SupabaseClient } from "@supabase/supabase-js";

import {
  diagnoseWorkbuddyTurnFromEnvironment,
  isAIAvailableFromEnvironment,
  type WorkbuddyTurnDiagnosis,
  type WorkbuddyTurnDiagnosisInput,
} from "@/lib/ai.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

const DEFAULT_CONTEXT_LIMIT = 12;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const MAX_DIAGNOSIS_LENGTH = 240;
const MAX_TAG_LENGTH = 32;

export type WorkbuddyDiagnosisConfig = {
  enabled: boolean;
  sampleRate: number;
  concurrency: number;
};

export type WorkbuddyDiagnosisJob = {
  eventId: string;
  sessionId: string;
  prompt: string;
  reply: string;
};

export type WorkbuddyDiagnosisContextItem = WorkbuddyTurnDiagnosisInput["context"][number];

export interface WorkbuddyDiagnosisGateway {
  loadRecentContext(sessionId: string, limit: number): Promise<WorkbuddyDiagnosisContextItem[]>;
  insertDiagnosis(input: {
    eventId: string;
    sessionId: string;
    text: string;
    severity: "ok" | "warn" | "error";
    tag: string | null;
  }): Promise<{ inserted: boolean }>;
}

export type WorkbuddyDiagnosisMetrics = {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  skippedDisabled: number;
  skippedUnavailable: number;
  skippedSampled: number;
  skippedNoFinding: number;
  duplicateWrites: number;
};

type DiagnosisLogger = {
  warn(message: string, details: { code: string; failure_count?: number }): void;
};

type SchedulerDependencies = {
  config: WorkbuddyDiagnosisConfig;
  gateway: WorkbuddyDiagnosisGateway;
  isAIAvailable(): boolean;
  diagnose(input: WorkbuddyTurnDiagnosisInput): Promise<WorkbuddyTurnDiagnosis | null>;
  random?: () => number;
  logger?: DiagnosisLogger;
};

export class WorkbuddyDiagnosisConfigurationError extends Error {
  constructor() {
    super("WORKBUDDY_DIAGNOSIS_CONFIG_INVALID");
    this.name = "WorkbuddyDiagnosisConfigurationError";
  }
}

function sanitizeDiagnosis(result: WorkbuddyTurnDiagnosis | null): WorkbuddyTurnDiagnosis | null {
  if (!result) return null;
  const text = result.text.trim().slice(0, MAX_DIAGNOSIS_LENGTH);
  if (!text) return null;
  const tag = result.tag?.trim().slice(0, MAX_TAG_LENGTH) || null;
  return {
    text,
    severity: result.severity,
    tag,
  };
}

function validateConfig(config: WorkbuddyDiagnosisConfig): WorkbuddyDiagnosisConfig {
  if (
    !Number.isFinite(config.sampleRate) ||
    config.sampleRate < 0 ||
    config.sampleRate > 1 ||
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > MAX_CONCURRENCY
  ) {
    throw new WorkbuddyDiagnosisConfigurationError();
  }
  return config;
}

export function workbuddyDiagnosisConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WorkbuddyDiagnosisConfig {
  const rawEnabled = environment.WORKBUDDY_AUTO_DIAGNOSIS_ENABLED?.trim();
  const rawSampleRate = environment.WORKBUDDY_AUTO_DIAGNOSIS_SAMPLE_RATE?.trim();
  const rawConcurrency = environment.WORKBUDDY_AUTO_DIAGNOSIS_CONCURRENCY?.trim();
  const enabled = rawEnabled === undefined || rawEnabled === "" ? true : rawEnabled === "true";
  const sampleRate =
    rawSampleRate === undefined || rawSampleRate === "" ? 1 : Number(rawSampleRate);
  const concurrency =
    rawConcurrency === undefined || rawConcurrency === ""
      ? DEFAULT_CONCURRENCY
      : Number(rawConcurrency);

  if (
    rawEnabled !== undefined &&
    rawEnabled !== "" &&
    rawEnabled !== "true" &&
    rawEnabled !== "false"
  ) {
    throw new WorkbuddyDiagnosisConfigurationError();
  }
  return validateConfig({ enabled, sampleRate, concurrency });
}

export function createWorkbuddyDiagnosisScheduler(dependencies: SchedulerDependencies) {
  const config = validateConfig(dependencies.config);
  const random = dependencies.random ?? Math.random;
  const logger =
    dependencies.logger ??
    ({
      warn(message, details) {
        console.warn(message, details);
      },
    } satisfies DiagnosisLogger);
  const queue: WorkbuddyDiagnosisJob[] = [];
  const idleWaiters: Array<() => void> = [];
  const metrics: WorkbuddyDiagnosisMetrics = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skippedDisabled: 0,
    skippedUnavailable: 0,
    skippedSampled: 0,
    skippedNoFinding: 0,
    duplicateWrites: 0,
  };

  function settleIdleWaiters() {
    if (queue.length !== 0 || metrics.running !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function recordFailure() {
    metrics.failed += 1;
    logger.warn("[WorkBuddy diagnosis]", {
      code: "WORKBUDDY_DIAGNOSIS_FAILED",
      failure_count: metrics.failed,
    });
  }

  async function run(job: WorkbuddyDiagnosisJob) {
    try {
      const context = await dependencies.gateway.loadRecentContext(
        job.sessionId,
        DEFAULT_CONTEXT_LIMIT,
      );
      const diagnosis = sanitizeDiagnosis(
        await dependencies.diagnose({
          prompt: job.prompt,
          reply: job.reply,
          context,
        }),
      );
      if (!diagnosis) {
        metrics.skippedNoFinding += 1;
        return;
      }

      const persisted = await dependencies.gateway.insertDiagnosis({
        eventId: job.eventId,
        sessionId: job.sessionId,
        text: diagnosis.text,
        severity: diagnosis.severity,
        tag: diagnosis.tag,
      });
      if (persisted.inserted) {
        metrics.succeeded += 1;
      } else {
        metrics.duplicateWrites += 1;
      }
    } catch {
      // Provider and storage errors may contain response bodies or credentials.
      // Keep the observable record to a stable code and monotonic process count.
      recordFailure();
    }
  }

  function pump() {
    while (metrics.running < config.concurrency && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      metrics.running += 1;
      void run(job).finally(() => {
        metrics.running -= 1;
        pump();
        settleIdleWaiters();
      });
    }
    settleIdleWaiters();
  }

  return {
    enqueue(job: WorkbuddyDiagnosisJob) {
      if (!config.enabled) {
        metrics.skippedDisabled += 1;
        return;
      }
      let aiAvailable = false;
      try {
        aiAvailable = dependencies.isAIAvailable();
      } catch {
        recordFailure();
        return;
      }
      if (!aiAvailable) {
        metrics.skippedUnavailable += 1;
        return;
      }
      if (config.sampleRate === 0 || (config.sampleRate < 1 && random() >= config.sampleRate)) {
        metrics.skippedSampled += 1;
        return;
      }
      queue.push(job);
      metrics.queued += 1;
      pump();
    },
    onIdle() {
      if (queue.length === 0 && metrics.running === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    getMetrics(): WorkbuddyDiagnosisMetrics {
      return { ...metrics };
    },
  };
}

type SupabaseDiagnosisClient = Pick<SupabaseClient<Database>, "from">;

export function createSupabaseWorkbuddyDiagnosisGateway(
  client: SupabaseDiagnosisClient,
): WorkbuddyDiagnosisGateway {
  return {
    async loadRecentContext(sessionId, limit) {
      const { data, error } = await client
        .from("timeline_items")
        .select("kind, text")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error("WORKBUDDY_DIAGNOSIS_CONTEXT_FAILED");
      return (data ?? []).reverse().map((item) => ({ kind: item.kind, text: item.text }));
    },
    async insertDiagnosis(input) {
      const { error } = await client.from("timeline_items").insert({
        session_id: input.sessionId,
        kind: "diagnosis",
        text: input.text,
        severity: input.severity,
        tag: input.tag,
        source_event_id: input.eventId,
        event_ordinal: 2,
      });
      if (error?.code === "23505") return { inserted: false };
      if (error) throw new Error("WORKBUDDY_DIAGNOSIS_PERSIST_FAILED");
      return { inserted: true };
    },
  };
}

let productionScheduler: ReturnType<typeof createWorkbuddyDiagnosisScheduler> | undefined;

function getProductionScheduler() {
  if (productionScheduler) return productionScheduler;
  productionScheduler = createWorkbuddyDiagnosisScheduler({
    config: workbuddyDiagnosisConfigFromEnvironment(),
    gateway: createSupabaseWorkbuddyDiagnosisGateway(supabaseAdmin),
    isAIAvailable: isAIAvailableFromEnvironment,
    diagnose: async (input) => {
      const result = await diagnoseWorkbuddyTurnFromEnvironment(input);
      return result.available ? result.diagnosis : null;
    },
  });
  return productionScheduler;
}

// Accurate scope: only events without a client diagnosis are enqueued by ingest.
export function enqueueWorkbuddyTurnDiagnosis(job: WorkbuddyDiagnosisJob) {
  try {
    getProductionScheduler().enqueue(job);
  } catch (error) {
    if (error instanceof WorkbuddyDiagnosisConfigurationError) {
      console.warn("[WorkBuddy diagnosis]", { code: "WORKBUDDY_DIAGNOSIS_CONFIG_INVALID" });
      return;
    }
    console.warn("[WorkBuddy diagnosis]", { code: "WORKBUDDY_DIAGNOSIS_SCHEDULER_FAILED" });
  }
}
