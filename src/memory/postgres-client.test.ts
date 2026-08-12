import { describe, expect, it, vi } from "vitest";

const postgresFactory = vi.hoisted(() => vi.fn(() => ({ end: vi.fn() })));

vi.mock("postgres", () => ({
  default: postgresFactory,
}));

describe("createPostgresMemoryClient", () => {
  it("silences PostgreSQL notices when echo is disabled", async () => {
    const { createPostgresMemoryClient } = await import("./postgres-client.js");

    createPostgresMemoryClient({
      url: "postgresql://postgres:secret@localhost:5432/agent_server",
      schema: "agent_memory",
      poolMax: 10,
      echo: false,
    });

    expect(postgresFactory).toHaveBeenCalledWith(
      "postgresql://postgres:secret@localhost:5432/agent_server",
      expect.objectContaining({
        debug: false,
        onnotice: expect.any(Function),
      }),
    );
  });

  it("keeps PostgreSQL notices enabled when echo is enabled", async () => {
    const { createPostgresMemoryClient } = await import("./postgres-client.js");

    createPostgresMemoryClient({
      url: "postgresql://postgres:secret@localhost:5432/agent_server",
      schema: "agent_memory",
      poolMax: 10,
      echo: true,
    });

    expect(postgresFactory).toHaveBeenCalledWith(
      "postgresql://postgres:secret@localhost:5432/agent_server",
      expect.objectContaining({
        debug: true,
        onnotice: undefined,
      }),
    );
  });
});
