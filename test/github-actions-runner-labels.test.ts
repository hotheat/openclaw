import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("GitHub Actions workflow runners", () => {
  it("does not require unavailable Blacksmith runners", async () => {
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

  it("keeps pull request CI on the fast test slice instead of the full parallel suite", async () => {
    const ciWorkflowPath = path.resolve(process.cwd(), ".github", "workflows", "ci.yml");
    const content = await readFile(ciWorkflowPath, "utf8");

    expect(content).toMatch(/- name: Run test suite\n\s+run: pnpm test:fast/);
    expect(content).not.toMatch(/- name: Run test suite\n\s+run: pnpm test\s*$/m);
  });
});
