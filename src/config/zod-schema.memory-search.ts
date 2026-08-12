import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

export const MemorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    extraPaths: z.array(z.string()).optional(),
    excludeGlobs: z.array(z.string()).optional(),
    lexicon: z
      .object({
        includeDefaults: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
        terms: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    experimental: z
      .object({
        sessionMemory: z.boolean().optional(),
      })
      .strict()
      .optional(),
    provider: z
      .union([
        z.literal("openai"),
        z.literal("local"),
        z.literal("gemini"),
        z.literal("voyage"),
        z.literal("mistral"),
      ])
      .optional(),
    remote: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional().register(sensitive),
        headers: z.record(z.string(), z.string()).optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
            wait: z.boolean().optional(),
            concurrency: z.number().int().positive().optional(),
            pollIntervalMs: z.number().int().nonnegative().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    fallback: z
      .union([
        z.literal("openai"),
        z.literal("gemini"),
        z.literal("local"),
        z.literal("voyage"),
        z.literal("mistral"),
        z.literal("none"),
      ])
      .optional(),
    model: z.string().optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
        modelCacheDir: z.string().optional(),
      })
      .strict()
      .optional(),
    store: z
      .object({
        driver: z.union([z.literal("sqlite"), z.literal("postgres")]).optional(),
        path: z.string().optional(),
        postgres: z
          .object({
            url: z.string().optional().register(sensitive),
            schema: z.string().optional(),
            poolMax: z.union([z.number().int().positive(), z.string()]).optional(),
            echo: z.union([z.boolean(), z.string()]).optional(),
          })
          .strict()
          .optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .strict()
          .optional(),
        cache: z
          .object({
            enabled: z.boolean().optional(),
            maxEntries: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        tokens: z.number().int().positive().optional(),
        overlap: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    sync: z
      .object({
        onSessionStart: z.boolean().optional(),
        onSearch: z.boolean().optional(),
        watch: z.boolean().optional(),
        watchDebounceMs: z.number().int().nonnegative().optional(),
        intervalMinutes: z.number().int().nonnegative().optional(),
        sessions: z
          .object({
            deltaBytes: z.number().int().nonnegative().optional(),
            deltaMessages: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
        hybrid: z
          .object({
            enabled: z.boolean().optional(),
            vectorWeight: z.number().min(0).max(1).optional(),
            textWeight: z.number().min(0).max(1).optional(),
            candidateMultiplier: z.number().int().positive().optional(),
            mmr: z
              .object({
                enabled: z.boolean().optional(),
                lambda: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            temporalDecay: z
              .object({
                enabled: z.boolean().optional(),
                halfLifeDays: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
