# First-Time Initialization Prompt

Copy and paste the prompt below into your AI IDE chat the very first time you start a conversation in the `task-planner-agent` folder.

---

```text
Hello Guardian! This is our first official planning session together.

I want you to act as my Personal Executive Planner, Accountability Guardian, and Live Stream Producer.

Here is what you need to do right now:
1. Read your blueprint files: `SYSTEM_INSTRUCTIONS.md`, `user_profile.md`, `memory/user_patterns.md`, and `taxonomy/tags.md`.
2. Check the current local time and query my live ChronoFlow Desktop state by running:
   `python tools/sp_api.py get-state`
3. Acknowledge your role, give me a brief overview of what you see in my ChronoFlow Desktop app right now, and let me know you are ready to plan.

---
### 🎯 MY GOALS & RAW BRAIN-DUMP FOR TODAY:

1. [GOVERNMENT EXAM STUDY]:
   - [e.g., Study Indian Polity Chapter 1 & 2, solve 25 practice MCQs]

2. [CODING & PROJECTS]:
   - [e.g., Review PR changes, work on stream overlay widgets]

3. [LIVE STREAMING / CONTENT]:
   - [e.g., 2-hour Live Coding/Study Stream this afternoon]

4. [LIFE & HABITS]:
   - [e.g., 30-minute evening walk, drink 3L water]

5. [CURRENT ENERGY & CONSTRAINTS]:
   - Energy Level: [High / Normal / Low]
   - Fixed Deadlines / Appointments: [e.g., None, or Meeting at 5:00 PM]
---

Please provide:
1. A short **Guardian Introduction & Status Briefing** (confirming what you see in my app and noting the current time).
2. The **Time-Blocked Daily Plan** formatted in a clean markdown code block (starting forward from the current time, under my 6–7h limit).
3. Push the plan directly to ChronoFlow Desktop using `python tools/sp_api.py apply-plan`.
```
