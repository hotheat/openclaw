export type ResearcherExportSummary = {
  exportPath: string;
  description: string;
};

export type StructuredMemoryCategory =
  | "preference"
  | "knowledge"
  | "context"
  | "behavior"
  | "goal"
  | "correction";

export type StructuredMemorySectionKey =
  | "workContext"
  | "personalContext"
  | "topOfMind"
  | "recentMonths"
  | "earlierContext"
  | "longTermBackground";

export type StructuredMemorySummarySection = {
  summary: string;
  updatedAt?: string;
};

export type StructuredMemorySummaryUpdate = {
  summary?: string;
  shouldUpdate?: boolean;
};

export type StructuredMemoryFact = {
  id: string;
  content: string;
  category: StructuredMemoryCategory;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  source: string;
  sourceError?: string;
  consolidationReason?: string;
};

export type SameCategoryConsolidationOperation = {
  op?: "merge" | "replace" | "append" | "drop";
  targetFactId?: string;
  canonicalContent?: string;
  confidence?: number;
  reason?: string;
};

export type SameCategoryConsolidationResult = {
  operations?: SameCategoryConsolidationOperation[];
};

export type StructuredMemoryFactUpdate = {
  content?: string;
  category?: StructuredMemoryCategory;
  confidence?: number;
  sourceError?: string;
};

export type StructuredMemoryPatch = {
  user?: Partial<
    Record<"workContext" | "personalContext" | "topOfMind", StructuredMemorySummaryUpdate>
  >;
  history?: Partial<
    Record<"recentMonths" | "earlierContext" | "longTermBackground", StructuredMemorySummaryUpdate>
  >;
  newFacts?: StructuredMemoryFactUpdate[];
  factsToRemove?: string[];
};

export type StructuredMemoryState = {
  user: Record<"workContext" | "personalContext" | "topOfMind", StructuredMemorySummarySection>;
  history: Record<
    "recentMonths" | "earlierContext" | "longTermBackground",
    StructuredMemorySummarySection
  >;
  facts: StructuredMemoryFact[];
};

export type SessionMemoryLlmOverrides = {
  provider?: string;
  model?: string;
};
