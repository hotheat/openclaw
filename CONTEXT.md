# OpenClaw

OpenClaw is a local-first AI gateway for routing work across agents, sessions, tools, and channels. This glossary defines project-specific language used when describing agent task state.

## Language

**TaskFlow**:
A durable task checklist owned by an agent session for work that needs planning, progress tracking, or recovery across context loss.
_Avoid_: TodoList, plan, checklist

**active TaskFlow**:
The single unfinished TaskFlow selected for an owner session. A session cannot have more than one active TaskFlow at the same time.
_Avoid_: current todo, active plan

**owner session**:
The agent session that created and controls a TaskFlow by default.
_Avoid_: parent session, creator

**local TaskFlow**:
A TaskFlow visible and writable only within its owner session boundary unless explicitly delivered as progress to a channel.
_Avoid_: private plan, internal todo

**shared TaskFlow**:
A TaskFlow whose access is explicitly granted to more than one agent session for coordinated work.
_Avoid_: global todo, inherited plan
