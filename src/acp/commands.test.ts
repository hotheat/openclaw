import { describe, expect, it } from "vitest";
import { getAvailableCommands } from "./commands.js";

describe("getAvailableCommands", () => {
  it("exposes /new as the only fresh-session command", () => {
    const commands = getAvailableCommands();

    expect(commands.find((command) => command.name === "reset")).toBeUndefined();
    expect(commands.find((command) => command.name === "new")).toEqual({
      name: "new",
      description: "Start a new session.",
    });
  });
});
