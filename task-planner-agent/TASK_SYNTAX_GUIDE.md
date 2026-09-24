# ChronoFlow Desktop Task & Markdown Paste Format Specification

This document provides the complete syntax reference for creating and pasting tasks into ChronoFlow Desktop. Any AI agent or human can use this format to generate single or multi-level task plans.

---

## 1. List Structure & Hierarchy

ChronoFlow Desktop uses standard Markdown list syntax:

* **Main Tasks:** `- [ ] Task title` or `- Task title` (0 indent)
* **Completed Tasks:** `- [x] Task title`
* **Subtasks:** Indented with 2 spaces or 1 tab (`  - [ ] Subtask title`)
* **Deep Nesting (Checklist Notes):** Indented with 4+ spaces — converted into Markdown checklist notes inside the parent task.

---

## 2. Short Syntax Tokens (Fields inside Task Titles)

You can embed metadata directly inside the task or subtask title using short syntax tokens. When pasted or typed, ChronoFlow Desktop automatically parses and strips these tokens into their respective fields:

| Field | Syntax | Examples | Description |
| :--- | :--- | :--- | :--- |
| **Time Estimate** | `[number][m\|h]` | `45m`, `1.5h`, `2h 30m` | Sets the planned estimated duration. |
| **Spent / Estimate** | `[spent]/[estimate]` | `15m/1h`, `45m/2h` | Sets both already-spent time and total estimate. |
| **Project** | `+[ProjectName]` | `+GovExam`, `+Coding`, `+Stream`, `+Life` | Assigns the task to the designated project. |
| **Tags** | `#[TagName]` | `#deepwork`, `#study`, `#revision`, `#urgent` | Attaches one or more tags (multiple allowed). |
| **Schedule / Due** | `@[date / time]` | `@today`, `@today 10:00`, `@tomorrow 14:30`, `@fri 3pm` | Schedules the task to the planner/today with optional reminder. |
| **Recurrence** | `@every [interval]` | `@every day`, `@every monday`, `@every weekday` | Creates a recurring task rule. |
| **Deadline** | `![date / time]` | `!today 18:00`, `!tomorrow`, `!2026-08-30` | Sets a hard deadline with visual urgency. |
| **Attachment Link** | `https://...` | `https://github.com/my-repo` | Automatically creates a clickable URL attachment. |

---

## 3. Complete Example of a Formatted Daily Plan

```markdown
- [ ] Complete Polity Chapter 4 Reading +GovExam #deepwork #study 45m @today 09:30 !today 12:00
  - [ ] Read Fundamental Rights articles (14 to 32) 30m
  - [ ] Write 1-page active recall summary 15m
- [ ] Solve Polity MCQs +GovExam #practice_mock #revision 30m @today 11:00
- [ ] Implement Stream Overlay 3-Tier Widget +Coding #dev #deepwork 1.5h @today 14:00
  - [ ] Code React layout in TopHeader.tsx 45m
  - [ ] Adjust CSS grid and font sizes 45m
- [ ] 2-Hour Live Coding & Study Stream +Stream #live 2h @today 16:30 !today 18:30
- [ ] Evening Walk & Health Reset +Life #health #routine 30m @today 20:00
```

---

## 4. How the AI Agent Should Structure Outputs

When generating daily schedules, the agent should:
1. Use `- [ ]` for every task and `  - [ ]` for every subtask.
2. Always attach a realistic **Time Estimate** (`30m`, `45m`, `1h`).
3. Always prefix with the correct **Project** (`+GovExam`, `+Coding`, `+Stream`, `+Life`).
4. Always tag with relevant **Categories** (`#deepwork`, `#study`, `#revision`, `#dev`, etc.).
5. Provide a scheduled start time using `@today HH:MM` for structured time-blocking.
