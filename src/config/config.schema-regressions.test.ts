import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "mistral"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "mistral",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch store driver "postgres" with postgres config', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            store: {
              driver: "postgres",
              postgres: {
                host: "${POSTGRES__HOST}",
                port: 5432,
                database: "${POSTGRES__DATABASE}",
                user: "${POSTGRES__USERNAME}",
                password: "${POSTGRES__PASSWORD}",
                schema: "openclaw_memory",
                ssl: false,
                poolMax: 10,
                echo: false,
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts memorySearch excludeGlobs", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            excludeGlobs: ["memory/private/**", "**/*-security-policy.md"],
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts safe iMessage remoteHost", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          remoteHost: "bot@gateway-host",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unsafe iMessage remoteHost", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          remoteHost: "bot@gateway-host -oProxyCommand=whoami",
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.remoteHost");
    }
  });

  it("accepts iMessage attachment root patterns", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
          remoteAttachmentRoots: ["/Volumes/relay/attachments"],
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects relative iMessage attachment roots", () => {
    const res = validateConfigObject({
      channels: {
        imessage: {
          attachmentRoots: ["./attachments"],
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.attachmentRoots.0");
    }
  });

  it("accepts per-agent thinkingDefault and heartbeat.thinking overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          thinkingDefault: "off",
          heartbeat: {
            thinking: "low",
          },
        },
        list: [
          {
            id: "researcher",
            thinkingDefault: "medium",
            heartbeat: {
              every: "2h",
              thinking: "off",
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts tools.web.fetch.firecrawl config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              enabled: true,
              apiKey: "test-firecrawl-key",
              baseUrl: "https://api.firecrawl.dev",
              onlyMainContent: true,
              maxAgeMs: 86_400_000,
              timeoutSeconds: 45,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects boolean tools.web.fetch.firecrawl selector syntax", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          fetch: {
            firecrawl: true,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("tools.web.fetch.firecrawl");
    }
  });
});
