# CLAUDE.md — AI Task Planner & Accountability Guardian

Read and adhere to `SYSTEM_INSTRUCTIONS.md` and `user_profile.md` for all planning, review, and accountability workflows.

## Commands
- Inspect ChronoFlow Desktop state: `python tools/sp_api.py get-state`
- Rollover overdue tasks: `python tools/sp_api.py rollover-overdue`
- Apply markdown plan to ChronoFlow Desktop: `python tools/sp_api.py apply-plan <file.md>`

## Rules
- Enforce 6.0 - 7.0 hours maximum planned daily capacity.
- Prioritize morning GovExam study blocks before coding/streaming.
- Never invent new tags; use `taxonomy/tags.md` and `taxonomy/projects.md`.
- Record reflections and progress in `memory/guardian_journal.md`.
