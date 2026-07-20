import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
  PluginHookHandlerMap,
} from "../../src/plugins/types.js";
import register, { isParentWebchatToolContext } from "./index.js";

function captureFactory(pluginConfig: Record<string, unknown>): OpenClawPluginToolFactory {
  let factory: OpenClawPluginToolFactory | undefined;
  const api = {
    pluginConfig,
    registerTool(value: OpenClawPluginToolFactory) {
      factory = value;
    },
    on() {},
  } as unknown as OpenClawPluginApi;
  register(api);
  if (!factory) {
    throw new Error("tool factory was not registered");
  }
  return factory;
}

function captureHandoffDelivery(
  pluginConfig: Record<string, unknown>,
): PluginHookHandlerMap["subagent_handoff_delivery"] {
  let handler: PluginHookHandlerMap["subagent_handoff_delivery"] | undefined;
  const api = {
    pluginConfig,
    registerTool() {},
    on(name: string, value: PluginHookHandlerMap["subagent_handoff_delivery"]) {
      if (name === "subagent_handoff_delivery") handler = value;
    },
  } as unknown as OpenClawPluginApi;
  register(api);
  if (!handler) throw new Error("subagent handoff delivery hook was not registered");
  return handler;
}

describe("webui-artifacts registration", () => {
  it("recognizes only a parent WebChat session", () => {
    expect(
      isParentWebchatToolContext({
        messageChannel: "webchat",
        sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
      }),
    ).toBe(true);
    expect(
      isParentWebchatToolContext({
        messageChannel: "internal",
        sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
      }),
    ).toBe(true);
    expect(
      isParentWebchatToolContext({
        messageChannel: "webchat",
        sessionKey: "agent:researcher:subagent:child_1",
      }),
    ).toBe(false);
    expect(
      isParentWebchatToolContext({
        messageChannel: "feishu",
        sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
      }),
    ).toBe(false);
    expect(
      isParentWebchatToolContext({
        messageChannel: "webchat",
        sessionKey: "agent:feishu-ou_1:webui:namespace:chat_1",
      }),
    ).toBe(false);
  });

  it("returns a tool only when endpoint, key, workspace, and parent WebChat context exist", () => {
    const factory = captureFactory({ endpoint: "http://127.0.0.1:8303", apiKey: "secret" });
    const validContext = {
      messageChannel: "webchat",
      sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
      workspaceDir: "/tmp/workspace",
    };

    const resolved = factory(validContext);
    expect(Array.isArray(resolved) ? resolved[0]?.name : resolved?.name).toBe(
      "webui_artifact_publish",
    );
    const internalResolved = factory({ ...validContext, messageChannel: "internal" });
    expect(
      Array.isArray(internalResolved) ? internalResolved[0]?.name : internalResolved?.name,
    ).toBe("webui_artifact_publish");
    expect(factory({ ...validContext, workspaceDir: undefined })).toBeNull();
    expect(factory({ ...validContext, messageChannel: "feishu" })).toBeNull();
    expect(
      factory({ ...validContext, sessionKey: "agent:researcher:subagent:child_1" }),
    ).toBeNull();
    expect(captureFactory({ endpoint: "http://127.0.0.1:8303" })(validContext)).toBeNull();
    expect(captureFactory({ apiKey: "secret" })(validContext)).toBeNull();
  });

  it("publishes staged artifacts before WebChat completion delivery", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "webchat-handoff-"));
    try {
      const relativePath = "artifacts/imports/researcher/run-1/report.md";
      await fs.mkdir(path.join(workspaceDir, path.dirname(relativePath)), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, relativePath), "# report\n", "utf8");

      const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/openclaw/internal/artifacts/init")) {
          return Response.json({
            artifactId: "artifact_1",
            upload: {
              url: "https://oss.example/upload",
              headers: {
                "content-md5": "test",
                "content-type": "text/markdown",
                "x-oss-meta-sha256": "test",
              },
            },
          });
        }
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const handler = captureHandoffDelivery({
        endpoint: "http://127.0.0.1:8303",
        apiKey: "secret",
      });

      await handler(
        {
          runId: "run-1",
          childSessionKey: "agent:researcher:subagent:child",
          requesterSessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
          content: "done",
          childWorkspaceDir: "/workspace-researcher",
          requesterWorkspaceDir: workspaceDir,
          requesterOrigin: { channel: "webchat" },
          artifacts: [{ relativePath, fileName: "report.md", title: "Report" }],
        },
        {},
      );

      const initCall = fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith("/api/v1/openclaw/internal/artifacts/init"),
      );
      expect(initCall).toBeDefined();
      const initBody = JSON.parse(String((initCall?.[1] as RequestInit | undefined)?.body));
      expect(initBody).toMatchObject({
        sessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
        fileName: "report.md",
        sourceToolCallId: "subagent-handoff:run-1:0",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns structured failures when handoff artifact publishing fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "webchat-handoff-"));
    try {
      const relativePath = "artifacts/imports/researcher/run-1/report.md";
      await fs.mkdir(path.join(workspaceDir, path.dirname(relativePath)), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, relativePath), "# report\n", "utf8");

      const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/openclaw/internal/artifacts/init")) {
          return Response.json({
            artifactId: "artifact_1",
            upload: {
              url: "https://oss.example/upload",
              headers: {
                "content-md5": "test",
                "content-type": "text/markdown",
                "x-oss-meta-sha256": "test",
              },
            },
          });
        }
        if (url === "https://oss.example/upload") {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const handler = captureHandoffDelivery({
        endpoint: "http://127.0.0.1:8303",
        apiKey: "secret",
      });

      const result = await handler(
        {
          runId: "run-1",
          childSessionKey: "agent:researcher:subagent:child",
          requesterSessionKey: "agent:feishu-ou_1:webchat:namespace:chat_1",
          content: "done",
          childWorkspaceDir: "/workspace-researcher",
          requesterWorkspaceDir: workspaceDir,
          requesterOrigin: { channel: "webchat" },
          artifacts: [{ relativePath, fileName: "report.md", title: "Report" }],
        },
        {},
      );

      expect(result).toEqual({
        failures: [
          {
            relativePath,
            message: "Artifact publish failed (artifactId=artifact_1, phase=upload)",
          },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not publish staged artifacts for a Feishu requester", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const handler = captureHandoffDelivery({
        endpoint: "http://127.0.0.1:8303",
        apiKey: "secret",
      });
      await handler(
        {
          runId: "run-1",
          childSessionKey: "agent:researcher:subagent:child",
          requesterSessionKey: "agent:feishu-ou_1:feishu:direct:ou_1",
          content: "done",
          childWorkspaceDir: "/workspace-researcher",
          requesterWorkspaceDir: "/workspace-feishu-ou_1",
          requesterOrigin: { channel: "feishu" },
          artifacts: [{ relativePath: "artifacts/imports/researcher/run-1/report.md" }],
        },
        {},
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
