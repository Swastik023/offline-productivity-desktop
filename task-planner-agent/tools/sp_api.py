#!/usr/bin/env python3
"""
ChronoFlow Desktop Direct API Client & Superpower Tool.
Enables the AI Agent to live-query and push tasks/plans directly into ChronoFlow Desktop.
"""

import json
import os
import re
import sys
import glob
import urllib.request
import urllib.error
from datetime import datetime, date

API_BASE = "http://127.0.0.1:3876"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AGENT_ROOT = os.path.dirname(SCRIPT_DIR)
APP_DATA_DIR = os.path.join(AGENT_ROOT, "app-data")


def get_auth_token():
    # 1. Check environment variable
    if os.environ.get("SP_LOCAL_API_TOKEN"):
        return os.environ.get("SP_LOCAL_API_TOKEN").strip()

    # 2. Check local agent token file
    local_token_file = os.path.join(AGENT_ROOT, "local-rest-api-token")
    if os.path.exists(local_token_file):
        try:
            with open(local_token_file, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass

    # 3. Check macOS Application Support token file
    app_support_token = os.path.expanduser("~/Library/Application Support/superProductivity/local-rest-api-token")
    if os.path.exists(app_support_token):
        try:
            with open(app_support_token, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass

    return None


def api_request(path, method="GET", body=None):
    token = get_auth_token()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = f"{API_BASE}{path}"
    data_bytes = json.dumps(body).encode("utf-8") if body else None

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            res_data = response.read().decode("utf-8")
            return json.loads(res_data) if res_data else {"ok": True}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            parsed = json.loads(err_body)
            return {"ok": False, "status": e.code, "error": parsed}
        except Exception:
            return {"ok": False, "status": e.code, "error": err_body}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def parse_duration_to_ms(text):
    if not text:
        return 0
    # Match patterns like 1.5h, 45m, 1h30m
    total_ms = 0
    h_match = re.search(r'(\d+(?:\.\d+)?)\s*h', text, re.IGNORECASE)
    m_match = re.search(r'(\d+(?:\.\d+)?)\s*m', text, re.IGNORECASE)
    if h_match:
        total_ms += int(float(h_match.group(1)) * 3600000)
    if m_match:
        total_ms += int(float(m_match.group(1)) * 60000)
    return total_ms


def get_live_projects_and_tags():
    # Try REST API first
    proj_res = api_request("/projects")
    tag_res = api_request("/tags")

    projects_map = {}  # title.lower() -> id
    tags_map = {}      # title.lower() -> id

    if proj_res.get("ok") and isinstance(proj_res.get("data"), list):
        for p in proj_res["data"]:
            clean_title = p.get("title", "").replace(" ", "").lower()
            projects_map[clean_title] = p.get("id")

    if tag_res.get("ok") and isinstance(tag_res.get("data"), list):
        for t in tag_res["data"]:
            clean_title = t.get("title", "").replace(" ", "").lower()
            tags_map[clean_title] = t.get("id")

    # Fallback to backup JSON if API is offline
    if not projects_map or not tags_map:
        json_files = glob.glob(os.path.join(APP_DATA_DIR, "*.json"))
        if json_files:
            latest = max(json_files, key=os.path.getmtime)
            try:
                with open(latest, "r", encoding="utf-8") as f:
                    d = json.load(f)
                    for pid, p in d.get("project", {}).get("entities", {}).items():
                        if p:
                            projects_map[p.get("title", "").replace(" ", "").lower()] = pid
                    for tid, t in d.get("tag", {}).get("entities", {}).items():
                        if t:
                            tags_map[t.get("title", "").replace(" ", "").lower()] = tid
            except Exception:
                pass

    return projects_map, tags_map


def parse_task_line(line):
    # Match checkbox: - [ ] or - [x] or * [ ]
    match = re.match(r'^(\s*)[-*]\s*\[([ xX])\]\s*(.+)$', line)
    if not match:
        # Match plain bullet: - task or * task
        bullet_match = re.match(r'^(\s*)[-*]\s+(.+)$', line)
        if not bullet_match:
            return None
        indent = bullet_match.group(1)
        is_done = False
        raw_text = bullet_match.group(2).strip()
    else:
        indent = match.group(1)
        is_done = match.group(2).lower() == 'x'
        raw_text = match.group(3).strip()

    is_subtask = len(indent) >= 2 or '\t' in indent

    # Extract Project: +Project
    project_match = re.search(r'\+([a-zA-Z0-9_\-]+)', raw_text)
    project_token = project_match.group(1) if project_match else None
    if project_match:
        raw_text = raw_text.replace(project_match.group(0), "")

    # Extract Tags: #tag
    tag_matches = re.findall(r'#([a-zA-Z0-9_\-]+)', raw_text)
    for tm in tag_matches:
        raw_text = raw_text.replace(f"#{tm}", "")

    # Extract Estimate: e.g. 45m, 1.5h, 30m/1h
    est_match = re.search(r'(?:(\d+(?:\.\d+)?[mh])\/)?(\d+(?:\.\d+)?[mh])', raw_text)
    time_spent_ms = 0
    time_estimate_ms = 0
    if est_match:
        if est_match.group(1):
            time_spent_ms = parse_duration_to_ms(est_match.group(1))
        if est_match.group(2):
            time_estimate_ms = parse_duration_to_ms(est_match.group(2))
        raw_text = raw_text.replace(est_match.group(0), "")

    # Extract Schedule: @today, @tomorrow
    due_day = None
    if "@today" in raw_text.lower():
        due_day = date.today().isoformat()
        raw_text = re.sub(r'@today(?:\s+\d{1,2}:\d{2})?', '', raw_text, flags=re.IGNORECASE)
    elif "@tomorrow" in raw_text.lower():
        from datetime import timedelta
        due_day = (date.today() + timedelta(days=1)).isoformat()
        raw_text = re.sub(r'@tomorrow(?:\s+\d{1,2}:\d{2})?', '', raw_text, flags=re.IGNORECASE)

    # Clean title
    clean_title = re.sub(r'\s+', ' ', raw_text).strip()

    return {
        "title": clean_title,
        "is_done": is_done,
        "is_subtask": is_subtask,
        "project_token": project_token,
        "tag_tokens": tag_matches,
        "time_estimate_ms": time_estimate_ms,
        "time_spent_ms": time_spent_ms,
        "due_day": due_day
    }


def apply_plan(markdown_text):
    projects_map, tags_map = get_live_projects_and_tags()
    lines = markdown_text.strip().split("\n")

    # Step 1: Parse into hierarchical groups
    parent_groups = []
    current_group = None

    for line in lines:
        if not line.strip() or line.strip().startswith("```"):
            continue
        task_data = parse_task_line(line)
        if not task_data or not task_data["title"]:
            continue

        if not task_data["is_subtask"]:
            current_group = {
                "parent": task_data,
                "subtasks": []
            }
            parent_groups.append(current_group)
        else:
            if current_group:
                current_group["subtasks"].append(task_data)

    created_count = 0
    print("🚀 Applying Daily Plan to ChronoFlow Desktop (Chronological Ordering)...")

    # Step 2: Push parent groups in reverse order so first tasks end up at the top in ChronoFlow Desktop
    for group in reversed(parent_groups):
        parent_data = group["parent"]

        # Resolve Project ID
        project_id = None
        if parent_data["project_token"]:
            clean_p = parent_data["project_token"].lower().replace("_", "")
            project_id = projects_map.get(clean_p)

        # Resolve Tag IDs
        tag_ids = []
        for tg in parent_data["tag_tokens"]:
            clean_t = tg.lower().replace("_", "")
            if clean_t in tags_map:
                tag_ids.append(tags_map[clean_t])

        payload = {
            "title": parent_data["title"],
            "isDone": parent_data["is_done"],
            "timeEstimate": parent_data["time_estimate_ms"],
            "timeSpent": parent_data["time_spent_ms"],
            "dueDay": parent_data["due_day"] or date.today().isoformat()
        }
        if project_id:
            payload["projectId"] = project_id
        if tag_ids:
            payload["tagIds"] = tag_ids

        res = api_request("/tasks", method="POST", body=payload)
        if res.get("ok"):
            created_task = res.get("data", {})
            parent_id = created_task.get("id")
            created_count += 1
            print(f"  ✅ [Parent Task] {parent_data['title']} (Est: {parent_data['time_estimate_ms']//60000}m)")

            # Push subtasks for this parent
            for st_data in group["subtasks"]:
                subtask_payload = {
                    "title": st_data["title"],
                    "parentId": parent_id,
                    "isDone": st_data["is_done"],
                    "timeEstimate": st_data["time_estimate_ms"],
                    "timeSpent": st_data["time_spent_ms"]
                }
                st_res = api_request("/tasks", method="POST", body=subtask_payload)
                if st_res.get("ok"):
                    created_count += 1
                    print(f"     ↳ [Subtask] {st_data['title']} (Est: {st_data['time_estimate_ms']//60000}m)")
                else:
                    print(f"     ❌ Error creating subtask '{st_data['title']}': {st_res.get('error')}")
        else:
            print(f"  ❌ Error creating parent task '{parent_data['title']}': {res.get('error')}")

    print(f"\n🎉 Successfully synced {created_count} tasks into ChronoFlow Desktop in chronological sequence!")


def rollover_overdue():
    today_str = date.today().isoformat()
    print(f"🔍 Checking for overdue tasks to rollover to today ({today_str})...")

    tasks_res = api_request("/tasks?source=active&includeDone=false")
    if not tasks_res.get("ok"):
        print(f"❌ Could not fetch tasks: {tasks_res.get('error')}")
        return

    tasks = tasks_res.get("data", [])
    overdue = [t for t in tasks if t.get("dueDay") and t["dueDay"] < today_str and not t.get("isDone")]

    if not overdue:
        print("✅ No overdue tasks found. All caught up!")
        return

    print(f"Found {len(overdue)} overdue task(s). Rolling over:")
    for t in overdue:
        task_id = t.get("id")
        title = t.get("title")
        res = api_request(f"/tasks/{task_id}", method="PATCH", body={"dueDay": today_str})
        if res.get("ok"):
            print(f"  ✅ Rolled over: {title} (was due: {t.get('dueDay')})")
        else:
            print(f"  ❌ Failed to rollover {title}: {res.get('error')}")


def get_live_state_summary():
    state_res = api_request("/api/productivity-state")
    if not state_res.get("ok"):
        print(f"❌ ChronoFlow Desktop REST API is not reachable on {API_BASE}.")
        print("💡 Make sure the ChronoFlow Desktop desktop app is open.")
        return

    data = state_res.get("data", {})
    timer = data.get("timer", {})
    today_tasks = data.get("todayTasks", [])
    current_task = data.get("currentTask", {})

    print("\n📊 === ChronoFlow Desktop Live State ===")
    print(f"App Status: {data.get('appStatus', 'unknown').upper()}")
    print(f"Timer Mode: {timer.get('mode', 'none')} | State: {timer.get('state', 'stopped')}")
    if current_task and current_task.get("title"):
        print(f"Active Task: 🟢 {current_task.get('title')}")
    print(f"Tasks in Today List: {len(today_tasks)}")
    for t in today_tasks:
        marker = "[x]" if t.get("isDone") else "[ ]"
        spent = t.get("timeSpentTodayMs", 0) // 60000
        est = t.get("estimateMs", 0) // 60000
        print(f"  - {marker} {t.get('title')} ({spent}m / {est}m)")
    print("=========================================\n")


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python tools/sp_api.py get-state")
        print("  python tools/sp_api.py rollover-overdue")
        print("  python tools/sp_api.py apply-plan <markdown_file_or_string>")
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd == "get-state":
        get_live_state_summary()
    elif cmd == "rollover-overdue":
        rollover_overdue()
    elif cmd == "apply-plan":
        if len(sys.argv) < 3:
            print("Error: Provide path to a markdown file or raw markdown text.")
            sys.exit(1)
        arg = sys.argv[2]
        if os.path.exists(arg):
            with open(arg, "r", encoding="utf-8") as f:
                content = f.read()
        else:
            content = arg
        apply_plan(content)
    else:
        print(f"Unknown command: {cmd}")


if __name__ == "__main__":
    main()
