#!/usr/bin/env python3
"""Regenerate data/data.bundle.js from data/knowledge.json and data/community.json.

Why this exists
---------------
Browsers refuse fetch() on file:// pages, so when index.html is opened by
double-click the app cannot read the JSON files directly. data.bundle.js is a
plain <script> mirror of the two JSON files that works in that situation.

The JSON files stay the single source of truth:
  * served over http (python -m http.server)  -> the app reads the JSON directly
  * opened by double-click (file://)          -> the app reads data.bundle.js

Run this after editing either JSON file:
    python tools/sync_data.py
It also validates the knowledge base and reports obvious mistakes.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LANGS = ("fr", "ar", "en")


def load(name):
    with open(DATA / name, encoding="utf-8") as fh:
        return json.load(fh)


def check_text(obj, where, problems):
    if not isinstance(obj, dict) or any(not obj.get(l) for l in LANGS):
        problems.append(f"{where}: missing one of {LANGS}")


def validate(kb, community):
    problems = []
    symptom_ids = {s["id"] for s in kb["symptoms"]}
    region_ids = {r["id"] for r in kb["regions"]}
    category_ids = {c["id"] for c in kb["categories"]}
    sources = set(kb["meta"]["sources"])
    levels = set(kb["meta"]["evidenceLevels"])

    for s in kb["symptoms"]:
        check_text(s["label"], f"symptom {s['id']}", problems)
        if s["category"] not in category_ids:
            problems.append(f"symptom {s['id']}: unknown category {s['category']}")
        for r in s["regions"]:
            if r not in region_ids:
                problems.append(f"symptom {s['id']}: unknown region {r}")

    def check_flag(flag, where):
        check_text(flag["title"], f"{where} title", problems)
        check_text(flag["message"], f"{where} message", problems)
        if flag.get("level") not in ("urgent", "soon"):
            problems.append(f"{where}: level must be urgent or soon")
        if not flag.get("all") and not flag.get("any"):
            problems.append(f"{where}: needs 'all' and/or 'any'")
        for cond in (flag.get("all") or []) + (flag.get("any") or []):
            sid = cond if isinstance(cond, str) else cond.get("symptom")
            if sid not in symptom_ids:
                problems.append(f"{where}: unknown symptom {sid}")

    for f in kb.get("redFlags", []):
        check_flag(f, f"redFlag {f['id']}")

    for c in kb["conditions"]:
        cid = c["id"]
        for key in ("name", "shortName", "about"):
            check_text(c[key], f"{cid}.{key}", problems)
        for ws in c["symptoms"]:
            if ws["id"] not in symptom_ids:
                problems.append(f"{cid}: unknown symptom {ws['id']}")
            if not 1 <= ws["weight"] <= 3:
                problems.append(f"{cid}: weight of {ws['id']} should be 1..3")
        for r in c.get("rules", []):
            check_text(r["label"], f"{cid} rule {r['id']}", problems)
            for sid in r.get("symptoms", []):
                if sid not in symptom_ids:
                    problems.append(f"{cid} rule {r['id']}: unknown symptom {sid}")
        for f in c.get("redFlags", []):
            check_flag(f, f"{cid} redFlag {f['id']}")
        for e in c["evidence"]:
            check_text(e["statement"], f"{cid} evidence {e['id']}", problems)
            if e["source"] not in sources:
                problems.append(f"{cid} evidence {e['id']}: unknown source {e['source']}")
            if e["level"] not in levels:
                problems.append(f"{cid} evidence {e['id']}: unknown level {e['level']}")
            if "verified" not in e:
                problems.append(f"{cid} evidence {e['id']}: missing 'verified'")
        for i, q in enumerate(c["doctorQuestions"]):
            check_text(q, f"{cid} question {i}", problems)
        for i, x in enumerate(c["exams"]):
            check_text(x["name"], f"{cid} exam {i} name", problems)
            check_text(x["why"], f"{cid} exam {i} why", problems)
        for i, l in enumerate(c["lifestyle"]):
            if not l.get("id"):
                problems.append(f"{cid} lifestyle {i}: missing id")
            check_text(l["text"], f"{cid} lifestyle {i}", problems)
            if l["source"] not in sources:
                problems.append(f"{cid} lifestyle {i}: unknown source {l['source']}")

    cond_ids = {c["id"] for c in kb["conditions"]}
    item_ids = {l["id"] for c in kb["conditions"] for l in c["lifestyle"] if l.get("id")}
    for card in community["cards"]:
        if card["condition"] not in cond_ids:
            problems.append(f"community {card['id']}: unknown condition {card['condition']}")
        # a card may only point to an item of the approved list (the community never adds ideas)
        if card.get("item") and card["item"] not in item_ids:
            problems.append(f"community {card['id']}: unknown approved item {card['item']}")
        for key in ("tried", "duration", "note"):
            check_text(card[key], f"community {card['id']}.{key}", problems)
    return problems


def main():
    kb = load("knowledge.json")
    community = load("community.json")
    problems = validate(kb, community)
    for p in problems:
        print("  ! " + p)

    payload = json.dumps({"knowledge": kb, "community": community}, ensure_ascii=False, separators=(",", ":"))
    out = DATA / "data.bundle.js"
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("/* GENERATED by tools/sync_data.py from knowledge.json + community.json. Do not edit by hand. */\n")
        fh.write("window.ANAJIA_DATA = " + payload + ";\n")

    evidence = sum(len(c["evidence"]) for c in kb["conditions"])
    unverified = sum(1 for c in kb["conditions"] for e in c["evidence"] if not e["verified"])
    print(f"Wrote {out.relative_to(ROOT)}: {len(kb['conditions'])} conditions, {len(kb['symptoms'])} symptoms, "
          f"{evidence} evidence items ({unverified} unverified), {len(community['cards'])} community cards.")
    if problems:
        print(f"{len(problems)} problem(s) found.")
        sys.exit(1)


if __name__ == "__main__":
    main()
