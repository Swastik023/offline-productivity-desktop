# ChronoFlow Desktop App Data Directory

This directory holds the live exported or auto-synced state from ChronoFlow Desktop.

---

## How to Link ChronoFlow Desktop's Auto-Save / Backup:

You can automatically keep this folder up to date with 1 simple setting in ChronoFlow Desktop:

1. In ChronoFlow Desktop, open **Settings** (gear icon in the bottom-left sidebar).
2. Go to **Sync & Export** -> **Automatic Backups** (or **Local File Sync**).
3. Set the Backup / Sync Directory path to:
   ```text
   /Users/swastik/Desktop/My_projects/projects/random projects/chronoflow-desktop-master/task-planner-agent/app-data
   ```
4. Check **Enable Automatic Backup**.

Now, whenever you add, complete, or edit tasks in ChronoFlow Desktop, a clean JSON file (e.g. `chronoflow-desktop-backup.json` or `sp-data.json`) is saved here automatically.

---

## What the AI Reads from this File:
* **All Projects & Tags:** Ensures 100% consistent matching.
* **Pending & Overdue Tasks:** Discovers unfinished tasks from yesterday.
* **Completed Tasks:** Identifies what was accomplished yesterday to suggest next milestones.
* **Time Worked Today:** Reads current logged hours.
