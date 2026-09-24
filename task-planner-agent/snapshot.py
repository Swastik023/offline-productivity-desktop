#!/usr/bin/env python3
"""
Snapshot Helper for ChronoFlow Desktop AI Planner Agent.
Reads live data from ChronoFlow Desktop (via Local REST API or auto-backup JSON)
and generates a clean, concise markdown snapshot for the AI agent.
"""

import json
import glob
import os
import sys
from datetime import datetime, date, timedelta
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DATA_DIR = os.path.join(SCRIPT_DIR, "app-data")
STATE_DIR = os.path.join(SCRIPT_DIR, "state")
OUTPUT_FILE = os.path.join(STATE_DIR, "current_summary.md")
REST_API_URL = "http://127.0.0.1:3876"


def format_ms(ms):
    if not ms or ms <= 0:
        return "0m"
    total_minutes = int(ms / 60000)
    hours = total_minutes // 60
    minutes = total_minutes % 60
    if hours > 0 and minutes > 0:
        return f"{hours}h {minutes}m"
    elif hours > 0:
        return f"{hours}h"
    else:
        return f"{minutes}m"


def load_from_backup_file():
    json_files = glob.glob(os.path.join(APP_DATA_DIR, "*.json"))
    if not json_files:
        return None
    # Pick the most recently modified JSON file
    latest_file = max(json_files, key=os.path.getmtime)
    try:
        with open(latest_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data, latest_file
    except Exception as e:
        print(f"Error reading backup file {latest_file}: {e}", file=sys.stderr)
        return None


def generate_markdown_summary(data, source_name):
    today_str = date.today().isoformat()
    yesterday_str = (date.today() - timedelta(days=1)).isoformat()

    # Extract projects
    projects = {}
    if "project" in data and "entities" in data["project"]:
        for pid, p in data["project"]["entities"].items():
            if p:
                projects[pid] = p.get("title", pid)

    # Extract tags
    tags = {}
    if "tag" in data and "entities" in data["tag"]:
        for tid, t in data["tag"]["entities"].items():
            if t:
                tags[tid] = t.get("title", tid)

    # Extract tasks
    tasks = {}
    if "task" in data and "entities" in data["task"]:
        tasks = data["task"]["entities"]
    elif "tasks" in data:
        tasks = {t.get("id"): t for t in data["tasks"] if t}

    today_tasks_pending = []
    today_tasks_done = []
    overdue_tasks = []
    yesterday_completed = []

    for tid, t in tasks.items():
        if not t or t.get("parentId"):
            continue  # Process top-level tasks first

        title = t.get("title", "Untitled")
        is_done = t.get("isDone", False)
        project_title = projects.get(t.get("projectId"), "")
        project_token = f" +{project_title.replace(' ', '')}" if project_title else ""
        
        task_tags = [tags.get(tag_id, "") for tag_id in t.get("tagIds", []) if tags.get(tag_id)]
        tags_token = " " + " ".join([f"#{tg.replace(' ', '')}" for tg in task_tags]) if task_tags else ""
        
        estimate_str = format_ms(t.get("timeEstimate", 0))
        spent_str = format_ms(t.get("timeSpent", 0))
        due_day = t.get("dueDay")

        subtasks = []
        for sid in t.get("subTaskIds", []):
            st = tasks.get(sid)
            if st:
                st_done = st.get("isDone", False)
                st_est = format_ms(st.get("timeEstimate", 0))
                st_marker = "- [x]" if st_done else "- [ ]"
                subtasks.append(f"  {st_marker} {st.get('title')} ({st_est})")

        task_entry = {
            "title": title,
            "project_token": project_token,
            "tags_token": tags_token,
            "estimate": estimate_str,
            "spent": spent_str,
            "due_day": due_day,
            "subtasks": subtasks,
            "is_done": is_done
        }

        # Check completed yesterday
        done_on = t.get("doneOn")
        if is_done and done_on:
            try:
                done_date = datetime.fromtimestamp(done_on / 1000).strftime("%Y-%m-%d")
                if done_date == yesterday_str:
                    yesterday_completed.append(task_entry)
            except Exception:
                pass

        # Check today vs overdue vs general pending
        if is_done:
            today_tasks_done.append(task_entry)
        else:
            if due_day and due_day < today_str:
                overdue_tasks.append(task_entry)
            else:
                today_tasks_pending.append(task_entry)

    # Build Markdown document
    os.makedirs(STATE_DIR, exist_ok=True)
    lines = [
        f"# Live Workspace State Snapshot — {today_str}",
        f"*Source: {source_name} | Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
        "",
        "## 1. Registered Master Projects",
        ", ".join([f"`+{p.replace(' ', '')}`" for p in projects.values()]) if projects else "*(None registered yet)*",
        "",
        "## 2. Registered Master Tags",
        ", ".join([f"`#{t.replace(' ', '')}`" for t in tags.values() if t not in ["TODAY"]]) if tags else "*(None registered yet)*",
        "",
        "## 3. Overdue & Unfinished Tasks (Action Required)",
    ]

    if overdue_tasks:
        for t in overdue_tasks:
            due_note = f" *(Due: {t['due_day']})*" if t["due_day"] else ""
            lines.append(f"- [ ] **{t['title']}**{t['project_token']}{t['tags_token']} ({t['estimate']}){due_note}")
            for st in t["subtasks"]:
                lines.append(st)
    else:
        lines.append("*(No overdue tasks)*")

    lines.extend([
        "",
        "## 4. Current Pending Tasks in Backlog / Today",
    ])

    if today_tasks_pending:
        for t in today_tasks_pending:
            lines.append(f"- [ ] **{t['title']}**{t['project_token']}{t['tags_token']} ({t['estimate']})")
            for st in t["subtasks"]:
                lines.append(st)
    else:
        lines.append("*(No pending tasks in queue)*")

    lines.extend([
        "",
        "## 5. Tasks Completed Yesterday / Recently (Progress Reference)",
    ])

    if yesterday_completed:
        for t in yesterday_completed:
            lines.append(f"- [x] {t['title']}{t['project_token']}{t['tags_token']} (Spent: {t['spent']})")
    elif today_tasks_done:
        for t in today_tasks_done[:5]:
            lines.append(f"- [x] {t['title']}{t['project_token']}{t['tags_token']} (Spent: {t['spent']})")
    else:
        lines.append("*(No recently completed tasks recorded)*")

    content = "\n".join(lines) + "\n"
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"✅ Snapshot written to: {OUTPUT_FILE}")
    print(f"📊 Summary: {len(projects)} Projects, {len(tags)} Tags, {len(overdue_tasks)} Overdue, {len(today_tasks_pending)} Pending, {len(yesterday_completed)} Finished Yesterday")


def main():
    backup_result = load_from_backup_file()
    if backup_result:
        data, file_path = backup_result
        generate_markdown_summary(data, f"Auto-Backup: {os.path.basename(file_path)}")
    else:
        # Create an initial placeholder snapshot
        os.makedirs(STATE_DIR, exist_ok=True)
        today_str = date.today().isoformat()
        content = f"""# Live Workspace State Snapshot — {today_str}
*Source: Initial Template | Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*

## 1. Registered Master Projects
`+GovExam`, `+Coding`, `+Stream`, `+Life`

## 2. Registered Master Tags
`#deepwork`, `#revision`, `#practice_mock`, `#coding`, `#review`, `#live`, `#prep`, `#break`, `#health`, `#admin`

## 3. Overdue & Unfinished Tasks (Action Required)
*(No overdue tasks)*

## 4. Current Pending Tasks in Backlog / Today
*(Ready for morning brain dump)*

## 5. Tasks Completed Yesterday / Recently (Progress Reference)
*(None yet)*
"""
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"ℹ️ Initial snapshot created at: {OUTPUT_FILE}")
        print("💡 Tip: Link ChronoFlow Desktop Auto-Backup to 'task-planner-agent/app-data' for automatic live state sync.")


if __name__ == "__main__":
    main()
