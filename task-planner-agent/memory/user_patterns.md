# User Patterns & Evolving Behavioral Heuristics

This file is the **Long-Term Memory & Adaptive Intelligence Log** of the Guardian Agent.
The agent updates this file after daily reviews to become progressively smarter, accurate, and tailored to the user's true working habits.

---

## 1. 🕒 Time-of-Day Dynamics & Scheduling Heuristics
* **Current-Time Awareness:** Always schedule forward from the *current local time*. If planning happens late (e.g. 11:30 AM or 02:00 PM), immediately recalculate the available waking hours budget instead of scheduling in the past.
* **Peak Cognitive Windows:**
  - **09:30 AM – 12:30 PM (Morning Gold Window):** Highest executive function. Reserve strictly for `#study` or complex `#deepwork`. Never schedule reactive admin/meetings here.
  - **02:00 PM – 05:30 PM (Afternoon Momentum Window):** Best for coding, live streaming, and interactive project tasks.
  - **08:30 PM – 10:00 PM (Evening Wind-Down):** Light revision, flashcards, admin, and next-day planning.

---

## 2. ⚡ Personal Velocity & Estimation Accuracy
*(Updated continuously as more tasks are logged)*
* **Gov Exam / Study:** ~45 mins per chapter reading, ~30 mins per 30 MCQs. Estimation accuracy: **High (1.0x)**.
* **Software Development / Debugging:** Tends to encounter rabbit holes. Estimation accuracy: **Moderate (1.25x buffer recommended)**.
* **Streaming Sessions:** High energy cost. Max 2.5 hours per stream block to prevent next-day burnout.

---

## 3. 🛡️ Friction Triggers & Behavioral Safeguards
* **Avoidance Pattern:** Large monolithic tasks (e.g., *"Build Auth Feature"*) trigger hesitation.
  * **Counter-measure:** Automatically decompose into 2–3 granular subtasks with (15m/30m) estimates before scheduling.
* **Context Switching:** Switching between coding and exam study within the same 1-hour block degrades focus.
  * **Counter-measure:** Enforce clean 90-minute themed blocks separated by a dedicated break.

---

## 4. 📚 Spaced Repetition & Study Retention Tracker
| Subject / Topic | Initial Study Date | Day 1 Recall (Done?) | Day 3 Mock (Done?) | Day 7 Test (Done?) |
|-----------------|--------------------|----------------------|--------------------|--------------------|
| Polity Ch 1–3   | 2026-08-22         | ✅ Done (2026-08-23)  | ⏳ Due 2026-08-25   | ⏳ Due 2026-08-29   |


## 🖥️ Live Stream & Co-Pilot Architecture
* **Left Screen (Private / Co-Pilot):** Antigravity / Guardian AI Assistant. Serves as live teleprompter, real-time teacher, command instructor, and speaking coach.
* **Right Screen (Public / Streamed):** Main working monitor shared with YouTube Live viewers (Terminal, OBS, ChronoFlow Desktop task overlay, code).
* **Dual Mission:**
  1. Master Senior DevOps / SRE & AI Agent Engineering (`hp_server` -> `arise` -> `gods_eye`) step-by-step.
  2. Master live communication, presentation, and technical speaking skills through guided run-of-show scripts and analogies.
