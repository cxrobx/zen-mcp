#!/usr/bin/env python3
"""Zen MCP usage from Claude Code transcripts, on this Mac and (with --laptop) the laptop.

  python3 scripts/zen-usage.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--laptop]

Counts every Zen tool call: mcp__zen*__<tool> calls (this Mac's Zen) and `zen-laptop <tool>`
shell calls (the laptop's Zen, driven from the mini). Reports calls, how many went through
`batch`, back-to-back runs (calls <=120 s apart) and the gap between calls. The gap is the
model-turn cost that batch exists to remove. --laptop runs this same script on the laptop
over `ssh laptop` (it must be awake) and prints both machines plus a combined line.
Reads transcripts only; prints counts, never transcript text.
"""
import argparse, datetime as dt, glob, json, os, re, statistics as st, subprocess, sys

def scan(since, until):
    rows = []  # (session, ts, tool, target)
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        for line in open(f, errors="ignore"):
            if "zen" not in line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("type") != "assistant" or not m.get("timestamp"):
                continue
            ts = dt.datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
            if since and ts < since or until and ts >= until:
                continue
            for c in m.get("message", {}).get("content") or []:
                if not isinstance(c, dict) or c.get("type") != "tool_use":
                    continue
                name = c.get("name", "")
                if re.match(r"mcp__zen[\w-]*__", name):
                    rows.append((f, ts, name.split("__")[-1], "local"))
                elif name == "Bash":
                    cmd = str(c.get("input", {}).get("command", ""))
                    for t in re.findall(r"zen-laptop\s+([a-z_]+)", cmd):
                        rows.append((f, ts, t, "laptop-via-mini"))
    return rows

def summarize(rows):
    by = {}
    for s, ts, tool, tgt in rows:
        by.setdefault(s, []).append(ts)
    gaps, runs = [], []
    for ts in by.values():
        ts.sort(); run = 1
        for a, b in zip(ts, ts[1:]):
            g = (b - a).total_seconds()
            if g <= 120: gaps.append(g); run += 1
            else: runs.append(run); run = 1
        runs.append(run)
    big = [r for r in runs if r >= 3]
    batch = sum(1 for r in rows if r[2] == "batch")
    return {
        "sessions": len(by), "calls": len(rows), "batch_calls": batch,
        "batch_share": round(batch / len(rows), 3) if rows else 0,
        "laptop_via_mini": sum(1 for r in rows if r[3] == "laptop-via-mini"),
        "median_gap_s": round(st.median(gaps), 1) if gaps else None,
        "p75_gap_s": round(st.quantiles(gaps, n=4)[2], 1) if len(gaps) > 3 else None,
        "runs_ge3": len(big), "median_run_len": st.median(big) if big else None,
        "agent_hours_est": round(sum(gaps) / 3600, 2),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since"); ap.add_argument("--until"); ap.add_argument("--laptop", action="store_true")
    ap.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    d = lambda s: dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc) if s else None
    rows = scan(d(a.since), d(a.until))
    if a.json:
        print(json.dumps([(r[0], r[1].isoformat(), r[2], r[3]) for r in rows])); return
    out = {"this-mac": rows}
    if a.laptop:
        args = [x for x in sys.argv[1:] if x != "--laptop"] + ["--json"]
        p = subprocess.run(["ssh", "-o", "ConnectTimeout=8", "laptop", "python3", "-", *args],
                           input=open(__file__).read(), capture_output=True, text=True)
        if p.returncode != 0:
            sys.exit(f"laptop scan failed (asleep?): {p.stderr.strip()[:200]}")
        out["laptop"] = [("laptop:" + s, dt.datetime.fromisoformat(t), tool, "local") for s, t, tool, tg in json.loads(p.stdout)]
        out["combined"] = out["this-mac"] + out["laptop"]
    for k, v in out.items():
        print(k, json.dumps(summarize(v)))

main()
