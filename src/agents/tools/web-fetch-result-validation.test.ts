import { describe, expect, it } from "vitest";
import { validateHtmlExtractionResult } from "./web-fetch-result-validation.js";

function buildLargeShellHtml(params?: {
  title?: string;
  bodyText?: string;
  rootAttributes?: string;
  scriptCount?: number;
  paddingChars?: number;
}) {
  const title = params?.title ?? "ClinicalTrials.gov";
  const bodyText = params?.bodyText ?? "<p>Show glossary</p>";
  const rootAttributes = params?.rootAttributes ?? 'id="root"';
  const scriptCount = params?.scriptCount ?? 4;
  const paddingChars = params?.paddingChars ?? 22_000;
  const scripts = Array.from(
    { length: scriptCount },
    (_, index) =>
      `<script>window.__boot${index}="${"x".repeat(Math.ceil(paddingChars / scriptCount))}";</script>`,
  ).join("");
  return `<!doctype html><html><head><title>${title}</title>${scripts}</head><body><div ${rootAttributes}></div>${bodyText}</body></html>`;
}

describe("validateHtmlExtractionResult", () => {
  it("classifies soft 404 pages as not_found", async () => {
    const html = `<!doctype html><html><head><title>404 Not Found</title></head><body><main><h1>Page not found</h1><p>Error 404.</p><p>The resource cannot be found.</p></main></body></html>`;

    const result = await validateHtmlExtractionResult({
      html,
      extractedText: "404 Not Found\n\nPage not found.\nError 404.\nThe resource cannot be found.",
      title: "404 Not Found",
      contentType: "text/html; charset=utf-8",
      httpStatus: 200,
    });

    expect(result.failureClass).toBe("not_found");
    expect(result.metadata.notFoundMarkerCount).toBeGreaterThanOrEqual(2);
  });

  it("classifies challenge shells as anti_bot_block", async () => {
    const html = `<!doctype html><html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></head><body><div class="challenge-form">Just a moment, please enable cookies.</div></body></html>`;

    const result = await validateHtmlExtractionResult({
      html,
      extractedText: "Just a moment\n\nPlease enable cookies",
      title: "Just a moment...",
      contentType: "text/html; charset=utf-8",
      httpStatus: 200,
    });

    expect(result.failureClass).toBe("anti_bot_block");
    expect(result.metadata.htmlHasHtmlChallengeMarker).toBe(true);
  });

  it("classifies large client-rendered shells as rendering_gap", async () => {
    const html = buildLargeShellHtml();

    const result = await validateHtmlExtractionResult({
      html,
      extractedText: "ClinicalTrials.gov\n\nShow glossary",
      title: "ClinicalTrials.gov",
      contentType: "text/html; charset=utf-8",
      httpStatus: 200,
    });

    expect(result.failureClass).toBe("rendering_gap");
    expect(result.metadata.htmlHasClientRenderRoot).toBe(true);
    expect(result.metadata.htmlHasEmptyClientRenderRoot).toBe(true);
  });

  it("classifies login and cookie interstitials as content_mismatch", async () => {
    const html = `<!doctype html><html><head><title>Sign in</title></head><body><main><h1>Sign in</h1><p>Log in with your email address to continue. Reset password if needed. Cookie preferences are required before you accept all cookies and proceed with the advertisement-supported experience.</p></main></body></html>`;

    const result = await validateHtmlExtractionResult({
      html,
      extractedText:
        "Sign in\n\nLog in with your email address to continue. Reset password if needed. Cookie preferences are required before you accept all cookies and proceed with the advertisement-supported experience.",
      title: "Sign in",
      contentType: "text/html; charset=utf-8",
      httpStatus: 200,
    });

    expect(result.failureClass).toBe("content_mismatch");
    expect(result.metadata.contentMismatchMarkerCount).toBeGreaterThanOrEqual(2);
  });

  it("does not misclassify article pages that mention challenge or 404 terms", async () => {
    const html = `<!doctype html><html><head><title>How CAPTCHA pages handle 404 errors</title><meta property="og:type" content="article"></head><body><article><h1>How CAPTCHA pages handle 404 errors</h1><p>This article explains why a page not found message can appear after a CAPTCHA flow, and why checking your browser does not always indicate a bot challenge.</p><p>It is a real article body with enough context to look like a genuine page rather than a shell.</p></article></body></html>`;

    const result = await validateHtmlExtractionResult({
      html,
      extractedText:
        "How CAPTCHA pages handle 404 errors\n\nThis article explains why a page not found message can appear after a CAPTCHA flow, and why checking your browser does not always indicate a bot challenge. It is a real article body with enough context to look like a genuine page rather than a shell.",
      title: "How CAPTCHA pages handle 404 errors",
      contentType: "text/html; charset=utf-8",
      httpStatus: 200,
    });

    expect(result.failureClass).toBeUndefined();
    expect(result.metadata.htmlLooksLikeArticle).toBe(true);
  });
});
