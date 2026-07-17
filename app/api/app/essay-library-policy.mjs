export const ESSAY_ANSWER_DISPLAY_MODES = ["full", "excerpt", "link_only"];
export const ESSAY_ANSWER_COPYRIGHT_STATUSES = [
  "original",
  "authorized",
  "fair_quote",
  "link_only",
  "pending_verification",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Returns an empty array only when an answer is safe to publish under the
 * configured product policy. This is a product gate, not a legal opinion.
 */
export function validateEssayAnswerPublication(input = {}) {
  const displayMode = String(input.displayMode ?? "");
  const copyrightStatus = String(input.copyrightStatus ?? "");
  const content = String(input.content ?? "").trim();
  const excerpt = String(input.excerpt ?? "").trim();
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  const errors = [];

  if (!ESSAY_ANSWER_DISPLAY_MODES.includes(displayMode)) errors.push("INVALID_DISPLAY_MODE");
  if (!ESSAY_ANSWER_COPYRIGHT_STATUSES.includes(copyrightStatus)) errors.push("INVALID_COPYRIGHT_STATUS");
  if (copyrightStatus === "pending_verification") errors.push("COPYRIGHT_PENDING_VERIFICATION");
  if (sourceUrl && !isHttpsUrl(sourceUrl)) errors.push("SOURCE_URL_MUST_BE_HTTPS");

  if (displayMode === "full") {
    if (!["original", "authorized"].includes(copyrightStatus)) errors.push("FULL_TEXT_REQUIRES_RIGHTS");
    if (!content) errors.push("FULL_TEXT_REQUIRED");
  }

  if (displayMode === "excerpt") {
    if (!["original", "authorized", "fair_quote"].includes(copyrightStatus)) errors.push("EXCERPT_REQUIRES_RIGHTS_OR_QUOTE");
    if (!excerpt) errors.push("EXCERPT_REQUIRED");
    if (copyrightStatus === "fair_quote" && !isHttpsUrl(sourceUrl)) errors.push("FAIR_QUOTE_SOURCE_URL_REQUIRED");
    if (copyrightStatus === "fair_quote" && excerpt.length > 1200) errors.push("FAIR_QUOTE_TOO_LONG");
  }

  if (displayMode === "link_only") {
    if (copyrightStatus !== "link_only" && copyrightStatus !== "original" && copyrightStatus !== "authorized") {
      errors.push("LINK_ONLY_COPYRIGHT_STATUS_REQUIRED");
    }
    if (!isHttpsUrl(sourceUrl)) errors.push("HTTPS_SOURCE_URL_REQUIRED");
  }

  return [...new Set(errors)];
}

export function isEssayAnswerPubliclyVisible(input = {}) {
  return String(input.publicationStatus ?? input.status ?? "") === "published"
    && Boolean(input.sourceActive)
    && validateEssayAnswerPublication(input).length === 0;
}

export function sanitizePublicEssayAnswer(input = {}) {
  const displayMode = String(input.displayMode ?? "");
  return {
    id: String(input.id ?? ""),
    sourceName: String(input.sourceName ?? ""),
    displayMode,
    content: displayMode === "full" ? String(input.content ?? "") : "",
    excerpt: displayMode === "link_only" ? "" : String(input.excerpt ?? ""),
    sourceUrl: String(input.sourceUrl ?? ""),
    sortOrder: Number(input.sortOrder ?? 0),
  };
}
