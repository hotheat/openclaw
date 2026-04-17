import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("GitHub Actions workflow runners", () => {
  it("uses GitHub-hosted runner labels that are available in this repository", async () => {
    const workflowsDir = path.resolve(process.cwd(), ".github", "workflows");
    const workflowFiles = (await readdir(workflowsDir)).filter((file) => file.endsWith(".yml"));

    const runsOnByFile = await Promise.all(
      workflowFiles.map(async (file) => {
        const content = await readFile(path.join(workflowsDir, file), "utf8");
        const runnerLabels = Array.from(
          content.matchAll(/runs-on:\s*([^\n]+)/g),
          (match) => match[1]?.trim() ?? "",
        );
        return { file, runnerLabels };
      }),
    );

    expect(runsOnByFile).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runnerLabels: expect.arrayContaining([expect.stringMatching(/blacksmith-/)]),
        }),
      ]),
    );
  });
});
