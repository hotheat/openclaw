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

  it("keeps pull request CI on the fast test slice and sidecar heavy slices instead of the full parallel suite", async () => {
    const ciWorkflowPath = path.resolve(process.cwd(), ".github", "workflows", "ci.yml");
    const content = await readFile(ciWorkflowPath, "utf8");

    expect(content).toMatch(/name:\s+test \/ shard-\$\{\{\s*matrix\.shard\s*\}\}/);
    expect(content).toMatch(
      /strategy:\s*\n\s+fail-fast:\s*false\s*\n\s+matrix:\s*\n\s+shard:\s+\["1\/4", "2\/4", "3\/4", "4\/4"\]/,
    );
    expect(content).toMatch(
      /- name: Run fast unit shard\n\s+run: node scripts\/run-test-fast-shard\.mjs \$\{\{\s*matrix\.shard\s*\}\}/,
    );
    expect(content).toMatch(/name:\s+test-browser/);
    expect(content).toMatch(/run:\s+pnpm test:browser -- --silent=passed-only/);
    expect(content).toMatch(/name:\s+test-embedded/);
    expect(content).toMatch(/run:\s+pnpm test:embedded -- --silent=passed-only/);
    expect(content).toMatch(/name:\s+test-triggers/);
    expect(content).toMatch(/run:\s+pnpm test:triggers -- --silent=passed-only/);
    expect(content).toMatch(/name:\s+test-web-auto-reply/);
    expect(content).toMatch(/run:\s+pnpm test:web-auto-reply -- --silent=passed-only/);
    expect(content).toMatch(/name:\s+test-doctor/);
    expect(content).toMatch(/run:\s+pnpm test:doctor-only -- --silent=passed-only/);
    expect(content).toMatch(/name:\s+test-telegram-media/);
    expect(content).toMatch(/run:\s+pnpm test:telegram-media -- --silent=passed-only/);
    expect(content).not.toMatch(/run:\s+pnpm test\s*$/m);
  });

  it("includes a Codex review workflow for pull requests", async () => {
    const workflowPath = path.resolve(process.cwd(), ".github", "workflows", "codex-review.yml");
    const content = await readFile(workflowPath, "utf8");

    expect(content).toMatch(/name: Codex Review/);
    expect(content).toMatch(/pull_request:/);
    expect(content).toMatch(/CODEX_TOKEN/);
    expect(content).toMatch(/\.github\/codex\/prompts\/review\.md/);
    expect(content).toMatch(/codex exec/);
    expect(content).toMatch(/--model gpt-5\.4/);
    expect(content).toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
    expect(content).toMatch(
      /PR_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    );
    expect(content).not.toMatch(/curl -fsSL .*install-codex\.sh/);
    expect(content).toMatch(/CODEX_VERSION:\s*\d+\.\d+\.\d+/);
    expect(content).toMatch(/npm install --global .*@openai\/codex@\$\{CODEX_VERSION\}/);
    expect(content).toMatch(/github\.rest\.issues\.listComments/);
    expect(content).toMatch(/github\.rest\.issues\.updateComment/);
    expect(content).toMatch(/const marker = ['"]<!-- codex-review -->['"]/);
  });

  it("includes an OpenClaw-specific Codex review prompt", async () => {
    const promptPath = path.resolve(process.cwd(), ".github", "codex", "prompts", "review.md");
    const content = await readFile(promptPath, "utf8");

    expect(content).toMatch(/OpenClaw/i);
    expect(content).toMatch(/plugin/i);
    expect(content).toMatch(/routing/i);
    expect(content).toMatch(/Output format/i);
  });
});
