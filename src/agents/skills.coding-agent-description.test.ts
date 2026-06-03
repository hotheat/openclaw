import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveOpenClawMetadata } from "./skills/frontmatter.js";

describe("skills/coding-agent frontmatter", () => {
  it("requires explicit enablement and a coding agent binary", () => {
    const skillPath = path.join(process.cwd(), "skills", "coding-agent", "SKILL.md");
    const raw = fs.readFileSync(skillPath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    const metadata = resolveOpenClawMetadata(frontmatter);
    const description = frontmatter.description ?? "";
    if (!metadata?.requires) {
      throw new Error("coding-agent skill must declare openclaw requires metadata");
    }
    expect(description.toLowerCase()).toContain("delegate coding work");
    expect(metadata.requires.config).toContain("skills.entries.coding-agent.enabled");
    expect(metadata.requires.anyBins).toEqual(["claude", "codex", "opencode"]);
    expect(metadata?.install?.map((spec) => spec.id)).toEqual(["node-claude", "node-codex"]);
  });
});
