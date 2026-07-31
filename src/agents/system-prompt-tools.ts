const CORE_TOOL_SUMMARIES: Record<string, string> = {
  read: "Read file contents",
  write: "Create or overwrite files",
  edit: "Make precise edits to files",
  apply_patch: "Apply multi-file patches",
  grep: "Search file contents for patterns",
  find: "Find files by glob pattern",
  ls: "List directory contents",
  exec: "Run shell commands (pty available for TTY-required CLIs)",
  process: "Manage background exec sessions",
  web_search: "Search the web (Brave API)",
  grok_search: "Search the web with xAI Grok for synthesized answers with citations",
  web_fetch: "Fetch and extract readable content from a URL",
  browser: "Control web browser",
  canvas: "Present/eval/snapshot the Canvas",
  nodes: "List/describe/notify/camera/screen on paired nodes",
  cron: "Manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
  message: "Send messages and channel actions",
  gateway: "Restart, apply config, or run updates on the running OpenClaw process",
  agents_list: "List agent ids allowed for sessions_spawn",
  sessions_list: "List other sessions (incl. sub-agents) with filters/last",
  sessions_history: "Fetch history for another session/sub-agent",
  sessions_send: "Send a message to another session/sub-agent",
  sessions_spawn: "Spawn a sub-agent session",
  subagents: "List, steer, or kill sub-agent runs for this requester session",
  session_status:
    "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
  image: "Analyze an image with the configured image model",
};

const TOOL_ORDER = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "find",
  "ls",
  "exec",
  "process",
  "web_search",
  "grok_search",
  "web_fetch",
  "browser",
  "canvas",
  "nodes",
  "cron",
  "message",
  "gateway",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "subagents",
  "session_status",
  "image",
];

export function buildToolListText(
  toolNames: string[],
  toolSummaries?: Record<string, string>,
): string {
  const canonicalByNormalized = new Map<string, string>();
  for (const rawName of toolNames ?? []) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }

  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    const summary = value?.trim();
    if (normalized && summary) {
      externalToolSummaries.set(normalized, summary);
    }
  }

  const availableTools = new Set(canonicalByNormalized.keys());
  const orderedTools = TOOL_ORDER.filter((tool) => availableTools.has(tool));
  const extraTools = Array.from(availableTools)
    .filter((tool) => !TOOL_ORDER.includes(tool))
    .toSorted();

  return [...orderedTools, ...extraTools]
    .map((tool) => {
      const name = canonicalByNormalized.get(tool) ?? tool;
      const summary = CORE_TOOL_SUMMARIES[tool] ?? externalToolSummaries.get(tool);
      return summary ? `- ${name}: ${summary}` : `- ${name}`;
    })
    .join("\n");
}

export function buildToolingSection(params: {
  toolNames: string[];
  toolSummaries?: Record<string, string>;
}): {
  availableTools: Set<string>;
  readToolName: string;
  toolingSection: string;
} {
  const canonicalByNormalized = new Map<string, string>();
  for (const rawName of params.toolNames) {
    const name = rawName.trim();
    if (name && !canonicalByNormalized.has(name.toLowerCase())) {
      canonicalByNormalized.set(name.toLowerCase(), name);
    }
  }
  const availableTools = new Set(canonicalByNormalized.keys());
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const subagentPollingTools = [
    availableTools.has("subagents") ? "`subagents list`" : "",
    availableTools.has("sessions_list") ? "`sessions_list`" : "",
  ].filter(Boolean);
  const subagentGuidance = [
    "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    ...(subagentPollingTools.length > 0
      ? [
          `Do not poll ${subagentPollingTools.join(" / ")} in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).`,
        ]
      : []),
  ].join("\n");
  const toolListText = buildToolListText(params.toolNames, params.toolSummaries);
  const toolingBlocks = [
    [
      "## Tooling",
      "Tool availability (filtered by policy):",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      toolListText || "No tools are available in this runtime.",
    ].join("\n"),
    ...(availableTools.has("exec")
      ? [
          [
            "For shell-based code search, prefer `rg` for text search and `rg --files` for file discovery because ripgrep is usually faster than grep/find. If `rg` is unavailable, fall back to available alternatives.",
            "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
          ].join("\n"),
        ]
      : []),
    ...(availableTools.has("exec") || availableTools.has("process")
      ? [
          `For long waits, avoid rapid poll loops: use ${
            availableTools.has("exec") && availableTools.has("process")
              ? `${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>)`
              : availableTools.has("exec")
                ? `${execToolName} with enough yieldMs`
                : `${processToolName}(action=poll, timeout=<ms>)`
          }.`,
        ]
      : []),
    ...(availableTools.has("sessions_spawn") ? [subagentGuidance] : []),
  ];
  return {
    availableTools,
    readToolName: resolveToolName("read"),
    toolingSection: `${toolingBlocks.join("\n\n")}\n`,
  };
}
