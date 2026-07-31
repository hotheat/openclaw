function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) {
    return true;
  }
  const modelId = params.modelId?.trim();
  if (!modelId) {
    return false;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const provider = normalizeOptionalLowercaseString(params.modelProvider);
  const normalizedFull = provider ? `${provider}/${normalizedModelId}` : undefined;
  return allowModels.some((entry) => {
    const normalized = normalizeOptionalLowercaseString(entry);
    return Boolean(
      normalized &&
      (normalized === normalizedFull ||
        (!normalized.includes("/") && normalized === normalizedModelId)),
    );
  });
}
