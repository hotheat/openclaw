export const SESSION_TITLE_MAX_LENGTH = 64;

export type ParsedSessionTitle = { ok: true; title: string } | { ok: false; error: string };

export function parseSessionTitle(raw: unknown): ParsedSessionTitle {
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid title: must be a string" };
  }
  const title = raw.trim();
  if (!title) {
    return { ok: false, error: "invalid title: empty" };
  }
  if (title.length > SESSION_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: `invalid title: too long (max ${SESSION_TITLE_MAX_LENGTH})`,
    };
  }
  return { ok: true, title };
}
