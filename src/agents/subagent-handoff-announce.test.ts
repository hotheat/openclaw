import { describe, expect, it } from "vitest";
import {
  buildSubagentHandoffAnnounceView,
  scrubSubagentHandoffText,
} from "./subagent-handoff-announce.js";
import { parseSubagentHandoff } from "./subagent-handoff.js";

function parseHandoff(record: Record<string, unknown>) {
  const handoff = parseSubagentHandoff(
    `<SUBAGENT_HANDOFF>${JSON.stringify(record)}</SUBAGENT_HANDOFF>`,
  );
  if (!handoff) {
    throw new Error("expected parsed handoff");
  }
  return handoff;
}

describe("buildSubagentHandoffAnnounceView", () => {
  it("renders only accepted artifacts with requester-relative paths", () => {
    const handoff = parseHandoff({
      export: {
        path: "artifacts/source/report.md",
        title: "Report",
        mime: "text/markdown",
      },
      verification: { status: "passed" },
    });

    const view = buildSubagentHandoffAnnounceView({
      handoff,
      acceptedArtifacts: [
        {
          sourceRelativePath: "artifacts/source/report.md",
          requesterRelativePath: "artifacts/requester/report.md",
        },
        {
          sourceRelativePath: "artifacts/source/unknown.md",
          requesterRelativePath: "artifacts/requester/unknown.md",
        },
      ],
      stagedArtifacts: [],
    });

    expect(view.deliverableArtifacts).toEqual([
      {
        relativePath: "artifacts/requester/report.md",
        fileName: undefined,
        title: "Report",
        mimeType: "text/markdown",
        verificationStatus: "passed",
        verificationSummary: undefined,
        deliveryStatus: "ready",
      },
    ]);
  });

  it("keeps blocked reasons but removes all artifact paths", () => {
    const sourcePath = "artifacts/pptx-generator/run-1/final.pptx";
    const handoff = parseHandoff({
      mode: "inline",
      summary: `Could not verify ${sourcePath}.`,
      verification: {
        status: "failed",
        summary: `Renderer failed for /home/user/workspace/${sourcePath}.`,
      },
      delivery: { status: "blocked" },
    });

    const view = buildSubagentHandoffAnnounceView({
      handoff,
      acceptedArtifacts: [],
      stagedArtifacts: [],
      workspacePaths: ["/home/user/workspace"],
    });

    expect(view.deliverableArtifacts).toEqual([]);
    expect(view.blocked).toBeDefined();
    expect(JSON.stringify(view)).not.toContain(sourcePath);
    expect(JSON.stringify(view)).not.toContain("/home/user/workspace");
  });

  it("scrubs warning metadata and delivery issue URLs", () => {
    const sourcePath = "artifacts/pptx-restyle/run-warning/final.pptx";
    const handoff = parseHandoff({
      export: { path: sourcePath, title: `Deck at ${sourcePath}` },
      verification: {
        status: "failed",
        summary: `Overflow in ${sourcePath}`,
      },
      delivery: { status: "warning" },
    });

    const view = buildSubagentHandoffAnnounceView({
      handoff,
      acceptedArtifacts: [
        {
          sourceRelativePath: sourcePath,
          requesterRelativePath: "deliverables/final.pptx",
        },
      ],
      stagedArtifacts: [],
      deliveryIssues: [
        {
          kind: "staging-failed",
          reason: "Upload failed: https://example.invalid/object?token=secret",
        },
      ],
    });

    expect(view.deliverableArtifacts[0]).toMatchObject({
      relativePath: "deliverables/final.pptx",
      deliveryStatus: "warning",
      verificationSummary: "Overflow in [artifact path]",
      title: "Deck at [artifact path]",
    });
    expect(view.deliveryIssues[0]?.reason).toBe("Upload failed: [url]");
  });
});

describe("scrubSubagentHandoffText", () => {
  it("keeps ordinary prose intact", () => {
    expect(scrubSubagentHandoffText("The report contains 12 artifacts.", [])).toBe(
      "The report contains 12 artifacts.",
    );
    expect(scrubSubagentHandoffText("Document the apiKey: field in the runbook.", [])).toBe(
      "Document the apiKey: field in the runbook.",
    );
  });

  it("removes internal artifact ids and credentials from delivery failures", () => {
    expect(
      scrubSubagentHandoffText(
        [
          "Artifact publish failed (artifactId=artifact_1, object_key=private/report).",
          "upload failed: Authorization: Bearer sk-live-secret",
          "retry token=session-secret apiKey=api-secret secretKey=storage-secret",
          "fileKey=file_123 artifact_id=artifact_2",
          String.raw`json {"artifact_id":"artifact_3","objectKey":"private/key"}`,
          'quoted apiKey="api-secret-2" token: "session-secret-2"',
          "short artifactId: abc objectKey: draft apiKey: abc",
        ].join(" "),
        [],
      ),
    ).toBe(
      [
        "Artifact publish failed ([internal id], [internal id]).",
        "upload failed: Authorization: [credential]",
        "retry [credential] [credential] [credential]",
        "[internal id] [internal id]",
        "json {[internal id],[internal id]}",
        "quoted [credential] [credential]",
        "short [internal id] [internal id] [credential]",
      ].join(" "),
    );
  });
});
