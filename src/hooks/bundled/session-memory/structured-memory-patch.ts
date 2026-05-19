import crypto from "node:crypto";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  MAX_LONG_TERM_FACTS,
  MIN_CORRECTION_CONFIDENCE,
  MIN_FACT_CONFIDENCE,
  STRUCTURED_MEMORY_CATEGORIES,
} from "./constants.js";
import { consolidateSameCategoryFact } from "./fact-consolidation.js";
import { normalizeFactText } from "./structured-memory-render.js";
import type {
  SessionMemoryLlmOverrides,
  StructuredMemoryCategory,
  StructuredMemoryPatch,
  StructuredMemorySectionKey,
  StructuredMemoryState,
  StructuredMemorySummarySection,
  StructuredMemorySummaryUpdate,
} from "./types.js";

function makeFactId(category: StructuredMemoryCategory, content: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${category}\n${normalizeFactText(content)}`)
    .digest("hex")
    .slice(0, 12);
  return `fact_${hash}`;
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

export function extractStructuredMemoryPatchJson(
  text: string | null,
): StructuredMemoryPatch | null {
  if (!text) {
    return null;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = (fenced || text).trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as StructuredMemoryPatch;
  } catch {
    return null;
  }
}

export function isStructuredMemoryPatchEmpty(patch: StructuredMemoryPatch | null): boolean {
  if (!patch) {
    return true;
  }
  const hasSummaryUpdate =
    Object.values(patch.user ?? {}).some(
      (item) => item?.shouldUpdate && normalizeFactText(item.summary ?? ""),
    ) ||
    Object.values(patch.history ?? {}).some(
      (item) => item?.shouldUpdate && normalizeFactText(item.summary ?? ""),
    );
  return !hasSummaryUpdate && !patch.newFacts?.length && !patch.factsToRemove?.length;
}

export async function applyStructuredMemoryPatch(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  llmOverrides?: SessionMemoryLlmOverrides;
  llmTimeoutMs: number;
  transcript: string | null;
  current: StructuredMemoryState;
  patch: StructuredMemoryPatch;
  generatedAt: string;
  source: string;
  sessionId?: string;
}): Promise<StructuredMemoryState> {
  const next: StructuredMemoryState = {
    user: {
      workContext: { ...params.current.user.workContext },
      personalContext: { ...params.current.user.personalContext },
      topOfMind: { ...params.current.user.topOfMind },
    },
    history: {
      recentMonths: { ...params.current.history.recentMonths },
      earlierContext: { ...params.current.history.earlierContext },
      longTermBackground: { ...params.current.history.longTermBackground },
    },
    facts: params.current.facts.map((fact) => ({ ...fact })),
  };

  const updateSummarySection = <T extends StructuredMemorySectionKey>(
    target: Record<T, StructuredMemorySummarySection>,
    key: T,
    update?: StructuredMemorySummaryUpdate,
  ) => {
    if (!update?.shouldUpdate) {
      return;
    }
    const summary = normalizeFactText(update.summary ?? "");
    if (!summary) {
      return;
    }
    target[key] = {
      summary,
      updatedAt: params.generatedAt,
    };
  };

  updateSummarySection(next.user, "workContext", params.patch.user?.workContext);
  updateSummarySection(next.user, "personalContext", params.patch.user?.personalContext);
  updateSummarySection(next.user, "topOfMind", params.patch.user?.topOfMind);
  updateSummarySection(next.history, "recentMonths", params.patch.history?.recentMonths);
  updateSummarySection(next.history, "earlierContext", params.patch.history?.earlierContext);
  updateSummarySection(
    next.history,
    "longTermBackground",
    params.patch.history?.longTermBackground,
  );

  const factsToRemove = new Set(
    (params.patch.factsToRemove ?? []).map((value) => value.trim()).filter(Boolean),
  );
  next.facts = next.facts.filter((fact) => !factsToRemove.has(fact.id));

  const factSource = `${params.source}:${params.sessionId ?? "unknown"}`;
  for (const fact of params.patch.newFacts ?? []) {
    const category = fact.category;
    if (!category || !STRUCTURED_MEMORY_CATEGORIES.has(category)) {
      continue;
    }
    const content = normalizeFactText(fact.content ?? "");
    const confidence = clampConfidence(fact.confidence);
    if (!content || confidence === null) {
      continue;
    }
    if (category === "correction" && confidence < MIN_CORRECTION_CONFIDENCE) {
      continue;
    }
    if (category !== "correction" && confidence < MIN_FACT_CONFIDENCE) {
      continue;
    }

    const normalizedKey = `${category}::${content.toLowerCase()}`;
    const exactMatchIndex = next.facts.findIndex(
      (item) =>
        `${item.category}::${normalizeFactText(item.content).toLowerCase()}` === normalizedKey,
    );
    if (exactMatchIndex >= 0) {
      const existing = next.facts[exactMatchIndex];
      next.facts[exactMatchIndex] = {
        ...existing,
        confidence: Math.max(existing.confidence, confidence),
        updatedAt: params.generatedAt,
        source: factSource,
        sourceError: fact.sourceError?.trim() || existing.sourceError,
        consolidationReason: existing.consolidationReason,
      };
      continue;
    }

    const sameCategoryFacts = next.facts.filter((item) => item.category === category);
    const consolidation = await consolidateSameCategoryFact({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      llmOverrides: params.llmOverrides,
      llmTimeoutMs: params.llmTimeoutMs,
      category,
      incomingFact: fact,
      existingFacts: sameCategoryFacts,
      transcript: params.transcript,
      generatedAt: params.generatedAt,
      source: params.source,
      sessionId: params.sessionId,
    });
    if (consolidation?.op === "drop") {
      continue;
    }
    if (
      (consolidation?.op === "merge" || consolidation?.op === "replace") &&
      consolidation.targetFactId
    ) {
      const targetIndex = next.facts.findIndex((item) => item.id === consolidation.targetFactId);
      if (targetIndex >= 0) {
        const existing = next.facts[targetIndex];
        next.facts[targetIndex] = {
          ...existing,
          content: normalizeFactText(consolidation.canonicalContent || content),
          confidence: Math.max(existing.confidence, confidence),
          updatedAt: params.generatedAt,
          source: factSource,
          sourceError: fact.sourceError?.trim() || existing.sourceError,
          consolidationReason:
            normalizeFactText(consolidation.reason ?? "") || existing.consolidationReason,
        };
        continue;
      }
    }
    if (consolidation?.op === "append" || !consolidation) {
      next.facts.push({
        id: makeFactId(category, content),
        content,
        category,
        confidence,
        createdAt: params.generatedAt,
        updatedAt: params.generatedAt,
        source: factSource,
        sourceError: fact.sourceError?.trim() || undefined,
        consolidationReason: normalizeFactText(consolidation?.reason ?? "") || undefined,
      });
      continue;
    }

    next.facts.push({
      id: makeFactId(category, content),
      content,
      category,
      confidence,
      createdAt: params.generatedAt,
      updatedAt: params.generatedAt,
      source: factSource,
      sourceError: fact.sourceError?.trim() || undefined,
      consolidationReason: normalizeFactText(consolidation?.reason ?? "") || undefined,
    });
  }

  if (next.facts.length > MAX_LONG_TERM_FACTS) {
    next.facts = [...next.facts]
      .toSorted(
        (a, b) =>
          b.confidence - a.confidence ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, MAX_LONG_TERM_FACTS);
  }

  return next;
}
