import { describe, expect, it } from "vitest";
import {
  analyzeSubagentHandoff,
  parseSubagentHandoff,
  parseSubagentHandoffBlocks,
} from "./subagent-handoff.js";

describe("parseSubagentHandoff", () => {
  it("normalizes export metadata and verification status", () => {
    const parsed = parseSubagentHandoff(
      [
        "done",
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          summary: "Deck ready",
          export: {
            path: "artifacts\\pptx-generator\\run-1\\final.pptx",
            title: "Deck",
            mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          },
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      mode: "export-file",
      summary: "Deck ready",
      quality: {
        gate: "managed",
        verificationStatus: "passed",
        verificationSummary: undefined,
        deliveryStatus: "ready",
      },
      artifacts: [
        {
          relativePath: "artifacts/pptx-generator/run-1/final.pptx",
          fileName: undefined,
          title: "Deck",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ],
      omittedArtifactCount: 0,
    });
  });

  it("allows failed verification only when delivery is warning", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/pptx-generator/run-warning/final.pptx" },
          verification: {
            status: "failed",
            summary: "Slide 7 contains text overflow.",
          },
          delivery: { status: "warning" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.quality).toEqual({
      gate: "managed",
      verificationStatus: "failed",
      verificationSummary: "Slide 7 contains text overflow.",
      deliveryStatus: "warning",
    });
  });

  it.each([
    {
      name: "failed verification without delivery metadata",
      verification: { status: "failed" },
      delivery: undefined,
    },
    {
      name: "failed verification declared ready",
      verification: { status: "failed" },
      delivery: { status: "ready" },
    },
    {
      name: "failed warning delivery without verification summary",
      verification: { status: "failed" },
      delivery: { status: "warning" },
    },
    {
      name: "unknown verification declared warning",
      verification: undefined,
      delivery: { status: "warning" },
    },
    {
      name: "passed verification declared blocked",
      verification: { status: "passed" },
      delivery: { status: "blocked" },
    },
    {
      name: "passed verification with invalid delivery status",
      verification: { status: "passed" },
      delivery: { status: "raedy" },
    },
  ])("normalizes $name to blocked", ({ verification, delivery }) => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/pptx-generator/run-blocked/final.pptx" },
          verification,
          delivery,
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.quality.deliveryStatus).toBe("blocked");
  });

  it("accepts arbitrary safe workspace-relative paths", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          exports: [
            { path: "/tmp/final.pptx" },
            { path: "../secret.txt" },
            { path: "MEMORY.md" },
            { path: "artifacts/other/final.pptx" },
            { path: "artifacts/pptx-generator/run-1/summary.md" },
            { path: "artifacts/pptx-restyle/run-1/final.pptx" },
          ],
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      "MEMORY.md",
      "artifacts/other/final.pptx",
      "artifacts/pptx-generator/run-1/summary.md",
      "artifacts/pptx-restyle/run-1/final.pptx",
    ]);
    expect(parsed?.quality.deliveryStatus).toBe("unmanaged");
  });

  it("keeps handoffs without quality fields unmanaged", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          export: {
            path: "artifacts/exports/feishu/research/report.md",
            title: "Research report",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.quality).toEqual({
      gate: "unmanaged",
      verificationStatus: "unknown",
      verificationSummary: undefined,
      deliveryStatus: "unmanaged",
    });
    expect(parsed?.artifacts[0]?.relativePath).toBe("artifacts/exports/feishu/research/report.md");
  });

  it("ignores exports declared by an explicit inline handoff", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "inline",
          export: { path: "artifacts/pptx-generator/run-inline/final.pptx" },
          verification: { status: "passed" },
          delivery: { status: "ready" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.mode).toBe("inline");
    expect(parsed?.artifacts).toEqual([]);
  });

  it("rejects the removed hybrid handoff mode", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "hybrid",
          export: { path: "artifacts/exports/feishu/research/report.md" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed).toBeUndefined();
  });

  it("preserves a blocked quality result for an inline handoff with no artifacts", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "inline",
          summary: "Rendering failed.",
          verification: { status: "failed", summary: "LibreOffice exited with code 1." },
          delivery: { status: "blocked" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      mode: "inline",
      summary: "Rendering failed.",
      quality: {
        gate: "managed",
        verificationStatus: "failed",
        verificationSummary: "LibreOffice exited with code 1.",
        deliveryStatus: "blocked",
      },
      artifacts: [],
    });
  });

  it("requires the handoff block to be the response trailer", () => {
    expect(
      parseSubagentHandoff(
        [
          '<SUBAGENT_HANDOFF>{"export":{"path":"artifacts/pptx-generator/run-1/final.pptx"}}</SUBAGENT_HANDOFF>',
          "trailing text",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("rejects paths longer than the protocol limit instead of truncating them", () => {
    const prefix = "artifacts/pptx-generator/";
    const suffix = "/final.pptx";
    const validLengthPath = `${prefix}${"a".repeat(1_024 - prefix.length - suffix.length)}${suffix}`;
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          export: { path: `${validLengthPath}.hidden` },
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.artifacts).toEqual([]);
  });

  it.each([
    "/tmp/final.pptx",
    "C:\\tmp\\final.pptx",
    "../secret.txt",
    "artifacts/../../secret.txt",
    "artifacts/\0secret.txt",
    "",
  ])("rejects unsafe path %j", (unsafePath) => {
    const parsed = parseSubagentHandoff(
      `<SUBAGENT_HANDOFF>${JSON.stringify({ export: { path: unsafePath } })}</SUBAGENT_HANDOFF>`,
    );
    expect(parsed?.artifacts).toEqual([]);
  });

  it("reports valid artifacts omitted by the parser limit", () => {
    const parsed = parseSubagentHandoff(
      [
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          artifacts: Array.from({ length: 21 }, (_, index) => ({
            path: `artifacts/pptx-generator/run-${index}/final.pptx`,
          })),
          verification: { status: "passed" },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(parsed?.artifacts).toHaveLength(20);
    expect(parsed?.omittedArtifactCount).toBe(1);
  });

  it("does not fall back past a malformed terminal handoff", () => {
    expect(
      parseSubagentHandoff(
        [
          '<SUBAGENT_HANDOFF>{"export":{"path":"artifacts/pptx-generator/old/final.pptx"}}</SUBAGENT_HANDOFF>',
          "<SUBAGENT_HANDOFF>invalid</SUBAGENT_HANDOFF>",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("uses the terminal valid handoff", () => {
    const parsed = parseSubagentHandoff(
      [
        "done",
        '<SUBAGENT_HANDOFF>{"export":{"path":"artifacts/pptx-generator/final/final.pptx"}}</SUBAGENT_HANDOFF>',
      ].join("\n"),
    );

    expect(parsed?.artifacts[0]?.relativePath).toBe("artifacts/pptx-generator/final/final.pptx");
  });

  it("returns shared stripped content even when the terminal payload is malformed", () => {
    const analyzed = analyzeSubagentHandoff(
      ["visible result", "<SUBAGENT_HANDOFF>", "invalid", "</SUBAGENT_HANDOFF>"].join("\n"),
    );

    expect(analyzed).toEqual({
      didFindHandoff: true,
      strippedContent: "visible result",
      handoff: undefined,
    });
  });

  it("parses mixed-case tags", () => {
    const analyzed = analyzeSubagentHandoff(
      [
        "visible result",
        "<subagent_handoff>",
        JSON.stringify({
          mode: "export-file",
          export: { path: "artifacts/exports/report.md" },
        }),
        "</Subagent_Handoff>",
      ].join("\n"),
    );

    expect(analyzed).toMatchObject({
      didFindHandoff: true,
      strippedContent: "visible result",
      handoff: {
        artifacts: [{ relativePath: "artifacts/exports/report.md" }],
      },
    });
  });

  it("parses multiple transcript blocks through the shared parser", () => {
    const handoffs = parseSubagentHandoffBlocks(
      [
        '<SUBAGENT_HANDOFF>{"export":{"path":"exports/one.md"}}</SUBAGENT_HANDOFF>',
        "visible text",
        '<subagent_handoff>{"export":{"path":"exports/two.md"}}</subagent_handoff>',
        "<SUBAGENT_HANDOFF>invalid</SUBAGENT_HANDOFF>",
      ].join("\n"),
    );

    expect(handoffs.map((handoff) => handoff.artifacts[0]?.relativePath)).toEqual([
      "exports/one.md",
      "exports/two.md",
    ]);
  });
});
