import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { generateHtml } from "./commands-export-session.js";

describe("session export HTML templates", () => {
  it("exposes tree traversal through the extracted model module", () => {
    const context = { window: {} as Record<string, unknown> };
    const source = fs.readFileSync(
      new URL("./export-html/template-tree.js", import.meta.url),
      "utf8",
    );
    vm.runInNewContext(source, context);
    const createTreeModel = context.window.createSessionTreeModel as (params: {
      entries: Array<Record<string, unknown>>;
      byId: Map<string, Record<string, unknown>>;
      labelMap: Map<string, string>;
    }) => {
      buildTree: () => Array<{ entry: { id: string } }>;
      getPath: (targetId: string) => Array<{ id: string }>;
      findNewestLeaf: (nodeId: string) => string;
    };
    const entries = [
      { id: "root", parentId: null, type: "message", message: { role: "user", content: "hi" } },
      {
        id: "leaf",
        parentId: "root",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ];
    const model = createTreeModel({
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry])),
      labelMap: new Map(),
    });

    expect(model.buildTree().map((node) => node.entry.id)).toEqual(["root"]);
    expect(model.getPath("leaf").map((entry) => entry.id)).toEqual(["root", "leaf"]);
    expect(model.findNewestLeaf("root")).toBe("leaf");
  });

  it("embeds the tree module before the application script without unresolved placeholders", () => {
    const html = generateHtml({
      header: null,
      entries: [],
      leafId: null,
      warnings: [
        {
          code: "tools.create_failed",
          message: "Tool construction failed; report uses empty tool list.",
        },
      ],
    });

    for (const placeholder of [
      "CSS",
      "TREE_JS",
      "JS",
      "SESSION_DATA",
      "MARKED_JS",
      "HIGHLIGHT_JS",
    ]) {
      expect(html).not.toContain(`{{${placeholder}}}`);
    }
    expect(html.indexOf("global.createSessionTreeModel")).toBeGreaterThan(-1);
    expect(html.indexOf("global.createSessionTreeModel")).toBeLessThan(
      html.indexOf("window.createSessionTreeModel"),
    );
  });
});
