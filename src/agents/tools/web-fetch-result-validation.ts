import { markdownToText } from "./web-fetch-utils.js";
import { sanitizeHtml, stripInvisibleUnicode } from "./web-fetch-visibility.js";

export const MIN_SUCCESS_TEXT_CHARS = 120;
export const LARGE_HTML_SHELL_MIN_BODY_CHARS = 20_000;
export const LARGE_HTML_SHELL_MAX_TEXT_CHARS = 240;
export const LARGE_HTML_SHELL_MIN_SCRIPT_COUNT = 3;

export type HtmlExtractionFailureClass =
  | "not_found"
  | "anti_bot_block"
  | "rendering_gap"
  | "content_mismatch";

export type HtmlExtractionValidationMetadata = {
  contentType: string;
  bodyLength: number;
  textLength: number;
  scriptCount: number;
  selectorProvided: boolean;
  selectorMatched: boolean;
  htmlHasTextChallengeMarker: boolean;
  htmlHasHtmlChallengeMarker: boolean;
  htmlLooksLikeArticle: boolean;
  htmlHasClientRenderRoot: boolean;
  htmlHasEmptyClientRenderRoot: boolean;
  htmlMainTextLength: number;
  notFoundMarkerCount: number;
  contentMismatchMarkerCount: number;
};

export type HtmlExtractionValidationResult = {
  failureClass?: HtmlExtractionFailureClass;
  metadata: HtmlExtractionValidationMetadata;
};

type ValidationParams = {
  html: string;
  extractedText: string;
  title?: string;
  contentType?: string | null;
  httpStatus: number;
  selectorProvided?: boolean;
  selectorMatched?: boolean;
};

type Marker = RegExp;

const NOT_FOUND_MARKERS: Marker[] = [
  /\bpage not found\b/i,
  /\berror 404\b/i,
  /\b404 not found\b/i,
  /\bthe resource cannot be found\b/i,
  /\bwas not found or does not implement icontroller\b/i,
];

const CHALLENGE_TEXT_MARKERS: Marker[] = [
  /\battention required\b/i,
  /\bverify you are human\b/i,
  /\bcaptcha\b/i,
  /\baccess denied\b/i,
  /\bjust a moment\b/i,
  /\bchecking your browser\b/i,
  /\bray id\b/i,
  /\bplease enable cookies\b/i,
];

const CHALLENGE_HTML_MARKERS: Marker[] = [
  /\/cdn-cgi\/challenge-platform/i,
  /__cf_chl_/i,
  /\bcf-mitigated\b/i,
  /\bcf-browser-verification\b/i,
  /\bchallenge-form\b/i,
  /\bcf-turnstile\b/i,
  /\bg-recaptcha\b/i,
];

const CONTENT_MISMATCH_MARKERS: Marker[] = [
  /\breset password\b/i,
  /\bforgot your password\b/i,
  /\badvertisement\b/i,
  /\bscroll to continue with content\b/i,
  /\bif the address matches a valid account\b/i,
  /\bemail address\b/i,
  /\bsign in\b/i,
  /\blog in\b/i,
  /\bcookie preferences\b/i,
  /\baccept all cookies\b/i,
];

const ARTICLE_IDENTITY_MARKERS: Marker[] = [
  /<article\b/i,
  /\bitemprop=["']articleBody["']/i,
  /\bitemtype=["'][^"']*schema\.org\/(?:Article|NewsArticle|BlogPosting)["']/i,
  /\bproperty=["']og:type["'][^>]*content=["']article["']/i,
  /\bcontent=["']article["'][^>]*property=["']og:type["']/i,
  /\bclass=["'][^"']*(?:article-body|article-content|article__body|entry-content|post-content|story-body|story-content)[^"']*["']/i,
  /\bid=["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|story-content)[^"']*["']/i,
];

const CLIENT_RENDER_ROOT_SELECTORS = [
  "#__next",
  "#__nuxt",
  "#root",
  "#app",
  "#app-root",
  "[data-reactroot]",
  "[ng-version]",
  "[ng-app]",
  "[data-app-root]",
  "[data-react-app]",
] as const;

const ARTICLE_IDENTITY_SELECTORS = [
  "article",
  "[itemprop='articleBody']",
  "[itemtype*='schema.org/Article']",
  "[itemtype*='schema.org/NewsArticle']",
  "[itemtype*='schema.org/BlogPosting']",
  "[class*='article-body']",
  "[class*='article-content']",
  "[class*='article__body']",
  "[class*='entry-content']",
  "[class*='post-content']",
  "[class*='story-body']",
  "[class*='story-content']",
] as const;

async function loadParseHtml(): Promise<typeof import("linkedom").parseHTML> {
  const linkedom = await import("linkedom");
  return linkedom.parseHTML;
}

function normalizeWhitespace(value: string): string {
  return stripInvisibleUnicode(value).replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function countMarkers(input: string, markers: Marker[]): number {
  return markers.reduce((count, marker) => count + (marker.test(input) ? 1 : 0), 0);
}

function textLengthForValidation(extractedText: string): number {
  return normalizeWhitespace(markdownToText(extractedText)).length;
}

function isHtmlContentType(contentType?: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("html");
}

function looksLikeArticleFromHtml(html: string): boolean {
  return ARTICLE_IDENTITY_MARKERS.some((marker) => marker.test(html));
}

function shouldTreatAsNotFound(params: {
  hasPageIdentity: boolean;
  httpStatus: number;
  notFoundMarkerCount: number;
  textLength: number;
}): boolean {
  if (params.hasPageIdentity) {
    return false;
  }
  if (params.httpStatus === 404) {
    return true;
  }
  return params.notFoundMarkerCount >= 2 && params.textLength <= 8000;
}

function shouldTreatAsChallenge(params: {
  hasPageIdentity: boolean;
  httpStatus: number;
  contentType: string;
  textLength: number;
  selectorMissed: boolean;
  htmlHasTextChallengeMarker: boolean;
  htmlHasHtmlChallengeMarker: boolean;
  combinedText: string;
  html: string;
}): boolean {
  if (params.hasPageIdentity) {
    return false;
  }
  if ([403, 429, 503].includes(params.httpStatus)) {
    return true;
  }

  const textChallengeMarkerCount = countMarkers(params.combinedText, CHALLENGE_TEXT_MARKERS);
  const hasTextChallengeSignal =
    params.htmlHasTextChallengeMarker ||
    (!isHtmlContentType(params.contentType) && textChallengeMarkerCount > 0);
  if (hasTextChallengeSignal) {
    return true;
  }

  const hasHtmlChallengeSignal =
    params.htmlHasHtmlChallengeMarker || countMarkers(params.html, CHALLENGE_HTML_MARKERS) > 0;
  if (hasHtmlChallengeSignal && (params.textLength < 400 || params.selectorMissed)) {
    return true;
  }

  return false;
}

function shouldTreatAsRenderingGap(params: {
  contentType: string;
  bodyLength: number;
  textLength: number;
  scriptCount: number;
  selectorMissed: boolean;
  htmlMainTextLength: number;
  htmlHasClientRenderRoot: boolean;
  htmlHasEmptyClientRenderRoot: boolean;
  hasPageIdentity: boolean;
  html: string;
}): boolean {
  if (!isHtmlContentType(params.contentType)) {
    return false;
  }
  if (params.selectorMissed) {
    return true;
  }
  if (
    params.htmlHasClientRenderRoot &&
    params.htmlHasEmptyClientRenderRoot &&
    params.htmlMainTextLength === 0 &&
    !params.hasPageIdentity
  ) {
    return true;
  }
  if (
    params.bodyLength > 500 &&
    params.textLength < MIN_SUCCESS_TEXT_CHARS &&
    params.scriptCount >= LARGE_HTML_SHELL_MIN_SCRIPT_COUNT
  ) {
    return true;
  }
  if (
    !params.hasPageIdentity &&
    params.bodyLength >= LARGE_HTML_SHELL_MIN_BODY_CHARS &&
    params.textLength <= LARGE_HTML_SHELL_MAX_TEXT_CHARS &&
    params.scriptCount >= LARGE_HTML_SHELL_MIN_SCRIPT_COUNT
  ) {
    return true;
  }
  if (/<script\b/i.test(params.html) && params.textLength < MIN_SUCCESS_TEXT_CHARS) {
    return true;
  }
  return false;
}

function shouldTreatAsContentMismatch(params: {
  contentType: string;
  textLength: number;
  selectorMissed: boolean;
  hasPageIdentity: boolean;
  contentMismatchMarkerCount: number;
  looksLikeNotFoundPage: boolean;
  looksLikeChallengePage: boolean;
  looksLikeUnrenderedPage: boolean;
}): boolean {
  if (!isHtmlContentType(params.contentType)) {
    return false;
  }
  if (params.selectorMissed) {
    return false;
  }
  if (params.hasPageIdentity) {
    return false;
  }
  if (
    params.looksLikeNotFoundPage ||
    params.looksLikeChallengePage ||
    params.looksLikeUnrenderedPage
  ) {
    return false;
  }
  if (params.textLength < MIN_SUCCESS_TEXT_CHARS) {
    return false;
  }
  return params.contentMismatchMarkerCount >= 2;
}

export async function validateHtmlExtractionResult(
  params: ValidationParams,
): Promise<HtmlExtractionValidationResult> {
  const contentType = params.contentType?.toLowerCase() ?? "";
  const bodyLength = params.html.length;
  const textLength = textLengthForValidation(params.extractedText);
  const scriptCount = (params.html.match(/<script\b/gi) ?? []).length;
  const selectorProvided = params.selectorProvided === true;
  const selectorMatched = params.selectorMatched === true;
  const selectorMissed = selectorProvided && !selectorMatched;
  const combinedText = normalizeWhitespace([params.title ?? "", params.extractedText].join("\n"));
  const htmlHasTextChallengeMarker = countMarkers(combinedText, CHALLENGE_TEXT_MARKERS) > 0;
  const htmlHasHtmlChallengeMarker = countMarkers(params.html, CHALLENGE_HTML_MARKERS) > 0;
  const notFoundMarkerCount = countMarkers(combinedText, NOT_FOUND_MARKERS);
  const contentMismatchMarkerCount = countMarkers(combinedText, CONTENT_MISMATCH_MARKERS);

  let htmlLooksLikeArticle = looksLikeArticleFromHtml(params.html);
  let htmlHasClientRenderRoot = false;
  let htmlHasEmptyClientRenderRoot = false;
  let htmlMainTextLength = 0;

  if (isHtmlContentType(contentType)) {
    try {
      const cleanHtml = await sanitizeHtml(params.html);
      const parseHTML = await loadParseHtml();
      const { document } = parseHTML(cleanHtml);

      for (const tagName of ["script", "style", "noscript"]) {
        for (const node of Array.from(document.querySelectorAll(tagName))) {
          node.remove();
        }
      }

      htmlLooksLikeArticle =
        htmlLooksLikeArticle ||
        ARTICLE_IDENTITY_SELECTORS.some((selector) => Boolean(document.querySelector(selector)));

      const mainNode = document.querySelector("main, article, [role='main']");
      htmlMainTextLength = normalizeWhitespace(mainNode?.textContent ?? "").length;

      const clientRenderRoot = CLIENT_RENDER_ROOT_SELECTORS.map((selector) =>
        document.querySelector(selector),
      ).find(Boolean);
      if (clientRenderRoot) {
        htmlHasClientRenderRoot = true;
        htmlHasEmptyClientRenderRoot =
          normalizeWhitespace(clientRenderRoot.textContent ?? "").length === 0;
      }
    } catch {
      // Best-effort validation: keep regex-derived signals when DOM parsing fails.
    }
  }

  const looksLikeNotFoundPage = shouldTreatAsNotFound({
    hasPageIdentity: htmlLooksLikeArticle,
    httpStatus: params.httpStatus,
    notFoundMarkerCount,
    textLength,
  });

  const looksLikeChallengePage = shouldTreatAsChallenge({
    hasPageIdentity: htmlLooksLikeArticle,
    httpStatus: params.httpStatus,
    contentType,
    textLength,
    selectorMissed,
    htmlHasTextChallengeMarker,
    htmlHasHtmlChallengeMarker,
    combinedText,
    html: params.html,
  });

  const looksLikeUnrenderedPage = shouldTreatAsRenderingGap({
    contentType,
    bodyLength,
    textLength,
    scriptCount,
    selectorMissed,
    htmlMainTextLength,
    htmlHasClientRenderRoot,
    htmlHasEmptyClientRenderRoot,
    hasPageIdentity: htmlLooksLikeArticle,
    html: params.html,
  });

  const looksLikeContentMismatch = shouldTreatAsContentMismatch({
    contentType,
    textLength,
    selectorMissed,
    hasPageIdentity: htmlLooksLikeArticle,
    contentMismatchMarkerCount,
    looksLikeNotFoundPage,
    looksLikeChallengePage,
    looksLikeUnrenderedPage,
  });

  const metadata: HtmlExtractionValidationMetadata = {
    contentType,
    bodyLength,
    textLength,
    scriptCount,
    selectorProvided,
    selectorMatched,
    htmlHasTextChallengeMarker,
    htmlHasHtmlChallengeMarker,
    htmlLooksLikeArticle,
    htmlHasClientRenderRoot,
    htmlHasEmptyClientRenderRoot,
    htmlMainTextLength,
    notFoundMarkerCount,
    contentMismatchMarkerCount,
  };

  if (looksLikeNotFoundPage) {
    return { failureClass: "not_found", metadata };
  }
  if (looksLikeChallengePage) {
    return { failureClass: "anti_bot_block", metadata };
  }
  if (looksLikeUnrenderedPage) {
    return { failureClass: "rendering_gap", metadata };
  }
  if (looksLikeContentMismatch) {
    return { failureClass: "content_mismatch", metadata };
  }

  return { metadata };
}
