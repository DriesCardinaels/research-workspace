"""Core logic for Review Helper: storage, guided-flow evaluation, consistency
checks, draft composition, and exports.

Everything here is pure Python standard library and is shared by the HTTP
server (review_helper.py) and the tests. The browser UI never decides
gating or checks itself; it renders what `evaluate()` returns.
"""

import copy
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_VERSION = 1
MAX_BACKUPS = 10
BACKUP_MIN_INTERVAL_S = 60

DECISION_TYPES = {"pcs_choice", "justification", "pcs_text"}
OPTIONAL_TYPES = {"dashboard", "sheet", "ledger_list", "references", "ledger_triage"}
LEDGER_TYPES = ("strength", "major", "minor", "question")


# --------------------------------------------------------------------------
# Config


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_config(base=HERE):
    return load_json(os.path.join(base, "form_schema.json")), load_json(os.path.join(base, "flow.json"))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def form_fields(form):
    return {f["id"]: f for f in form["fields"]}


def iter_questions(flow):
    for step in flow["steps"]:
        for q in step["questions"]:
            yield step, q


def question_index(flow):
    return {q["id"]: (step, q) for step, q in iter_questions(flow)}


def is_required(q):
    if "required" in q:
        return bool(q["required"])
    return q["type"] not in OPTIONAL_TYPES


def question_feeds(step, q):
    if q["type"] in ("pcs_choice", "pcs_text"):
        return [q["field"]]
    return q.get("feeds", step.get("feeds", []))


# --------------------------------------------------------------------------
# State


def sanitize_paper_id(raw):
    pid = re.sub(r"[^A-Za-z0-9._-]+", "-", (raw or "").strip()).strip(".-")
    return pid[:80]


def new_state(paper_id, form, title="", pdf_path=""):
    ts = now_iso()
    return {
        "schema_version": SCHEMA_VERSION,
        "form_version": form["version"],
        "meta": {
            "paper_id": paper_id,
            "title": title,
            "role": "",
            "pdf_path": pdf_path,
            "created_at": ts,
            "updated_at": ts,
        },
        "current": {"step": "s0", "page": 0},
        "answers": {},
        "ledger": [],
        "pcs": {
            f["id"]: {
                "heading": f["heading"],
                "field_id": f["id"],
                "type": f["type"],
                "options": f.get("options"),
                "value": "" if f["type"] == "text" else None,
                "updated_at": None,
            }
            for f in form["fields"]
        },
        "step_meta": {},
        "check_resolutions": {},
    }


def answer_value(state, qid, default=None):
    a = state.get("answers", {}).get(qid)
    return default if a is None else a.get("value", default)


def pcs_value(state, field):
    return (state.get("pcs", {}).get(field) or {}).get("value")


def _changed(a, b):
    return json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True)


def apply_update(old, new, form, flow, ts=None):
    """Merge an incoming state from the client onto the stored one.

    The server owns timestamps: anything whose value changed gets a fresh
    `updated_at`. Each answer is stamped with its question text and the PCS
    headings it feeds so the saved file stands on its own.
    """
    ts = ts or now_iso()
    out = copy.deepcopy(new)
    fields = form_fields(form)
    qidx = question_index(flow)

    out["schema_version"] = SCHEMA_VERSION
    out.setdefault("form_version", form["version"])
    out.setdefault("step_meta", {})
    out.setdefault("check_resolutions", {})
    out.setdefault("ledger", [])

    meta = out.setdefault("meta", {})
    meta["created_at"] = (old or {}).get("meta", {}).get("created_at") or meta.get("created_at") or ts
    meta["paper_id"] = (old or {}).get("meta", {}).get("paper_id") or meta.get("paper_id")

    # answers
    old_answers = (old or {}).get("answers", {})
    answers = {}
    for qid, a in (out.get("answers") or {}).items():
        if qid not in qidx:
            continue
        step, q = qidx[qid]
        prev = old_answers.get(qid)
        value = a.get("value") if isinstance(a, dict) else a
        changed = prev is None or _changed(prev.get("value"), value)
        answers[qid] = {
            "question": q["text"],
            "step": step["id"],
            "pcs_headings": [fields[f]["heading"] for f in question_feeds(step, q) if f in fields],
            "value": value,
            "updated_at": ts if changed else prev.get("updated_at", ts),
        }
    out["answers"] = answers

    # ledger
    old_ledger = {i.get("id"): i for i in (old or {}).get("ledger", [])}
    for item in out["ledger"]:
        prev = old_ledger.get(item.get("id"))
        body = {k: v for k, v in item.items() if k not in ("created_at", "updated_at")}
        prev_body = {k: v for k, v in (prev or {}).items() if k not in ("created_at", "updated_at")}
        item["created_at"] = (prev or {}).get("created_at") or ts
        item["updated_at"] = ts if (prev is None or _changed(body, prev_body)) else prev.get("updated_at", ts)
        dim_field = {"soundness": "soundness", "reproducibility": "reproducibility", "clarity": "clarity",
                     "references": "references", "ethics": "diversity"}.get(item.get("dimension"))
        item["pcs_headings"] = [fields["review"]["heading"]] + ([fields[dim_field]["heading"]] if dim_field else [])

    # pcs
    old_pcs = (old or {}).get("pcs", {})
    pcs = {}
    for f in form["fields"]:
        incoming = (out.get("pcs") or {}).get(f["id"]) or {}
        value = incoming.get("value", "" if f["type"] == "text" else None)
        if f["type"] == "choice" and value not in (f.get("options") or []):
            value = None
        prev = old_pcs.get(f["id"]) or {}
        changed = _changed(prev.get("value"), value) if prev else value not in (None, "")
        pcs[f["id"]] = {
            "heading": f["heading"],
            "field_id": f["id"],
            "type": f["type"],
            "options": f.get("options"),
            "value": value,
            "updated_at": ts if changed else prev.get("updated_at"),
        }
    out["pcs"] = pcs

    # No human participants: the three participant fields are "Not applicable".
    if answer_value(out, "s1_humans") == "no":
        for fid in ("irb", "demographics", "diversity"):
            na = fields[fid].get("na_option")
            if na and pcs[fid]["value"] != na:
                pcs[fid]["value"] = na
                pcs[fid]["updated_at"] = ts

    # step completion is stamped by the server so it compares with edit times
    old_sm = (old or {}).get("step_meta", {})
    for sid, sm in out["step_meta"].items():
        if sm.pop("complete", False):
            sm["completed_at"] = ts
        elif old_sm.get(sid, {}).get("completed_at") and not sm.get("completed_at"):
            sm["completed_at"] = old_sm[sid]["completed_at"]

    keys = ("title", "role", "pdf_path")
    old_meta = (old or {}).get("meta", {})
    if old is None or any(old_meta.get(k) != meta.get(k) for k in keys):
        meta["edited_at"] = ts
    else:
        meta["edited_at"] = old_meta.get("edited_at")
    meta["updated_at"] = ts
    return out


# --------------------------------------------------------------------------
# Flow evaluation


def _cond(state, cond):
    if not cond:
        return True
    if "answer" in cond:
        v = answer_value(state, cond["answer"])
        if "equals" in cond:
            return v == cond["equals"]
        if "includes_any" in cond:
            return bool(set(v or []) & set(cond["includes_any"]))
    if "pcs" in cond:
        return pcs_value(state, cond["pcs"]) in cond.get("in", [])
    return True


def step_applies(state, step):
    cond = step.get("applies_if")
    if cond and "answer" in cond and answer_value(state, cond["answer"]) in (None, "", []):
        return True  # undecided yet: keep the step in the flow
    return _cond(state, cond)


def visible_questions(state, step):
    return [q for q in step["questions"] if _cond(state, q.get("show_if"))]


def claims(state):
    return [c for c in (answer_value(state, "s1_claims") or []) if (c.get("text") or "").strip()]


def active_ledger(state, type_=None):
    items = [i for i in state.get("ledger", []) if not i.get("dropped")]
    if type_:
        items = [i for i in items if i.get("type") == type_]
    return sorted(items, key=lambda i: (i.get("rank") if i.get("rank") is not None else 10**6, i.get("created_at") or ""))


def novelty_hit(text, flow):
    t = (text or "").lower()
    return any(w in t for w in flow["lexicons"]["novelty"])


def major_missing(item, flow):
    missing = [k for k in ("what", "where", "why", "fix") if not (item.get(k) or "").strip()]
    if not item.get("feasible"):
        missing.append("feasible")
    if novelty_hit(" ".join(str(item.get(k) or "") for k in ("text", "what", "why")), flow) and not item.get("novelty_confirmed"):
        missing.append("novelty_confirmed")
    return missing


def suggest_demographics(state, form):
    opts = form_fields(form)["demographics"]["options"]
    items = set(answer_value(state, "s7_demo_items") or [])
    if not items or "Nothing reported" in items:
        return opts[3]
    core = {"Number of participants (N)", "Age (mean/SD/range)", "Gender"}
    if core <= items and "Recruitment procedure" in items and len(items) >= 5:
        return opts[1]
    return opts[2]


def missing_for(state, q, form, flow, claim_id=None):
    """Why question `q` isn't answered yet ([] when it is)."""
    t = q["type"]
    v = answer_value(state, q["id"])
    if t == "meta":
        m = state.get("meta", {})
        out = []
        if not (m.get("title") or "").strip():
            out.append("Enter the paper title")
        if not m.get("role"):
            out.append("Choose your reviewer role")
        return out
    if t == "ack":
        return [] if v is True else ["Confirm the confidentiality statement"]
    if t in ("text", "justification", "review_section"):
        return [] if (v or "").strip() else ["Write an answer"]
    if t == "choice":
        if not v:
            return ["Choose an option"]
        if q.get("must_equal") and v != q["must_equal"]:
            return ["Revise until the answer is “%s”" % q["must_equal"]]
        return []
    if t == "multi":
        return [] if v else ["Select at least one option"]
    if t == "check":
        if not v or not v.get("status"):
            return ["Choose an answer"]
        if v["status"] in q.get("note_required_for", ["na", "unsure"]) and not (v.get("note") or "").strip():
            return ["Add a short reason for “%s”" % v["status"]]
        return []
    if t == "claims":
        return [] if claims(state) else ["Add at least one claimed contribution"]
    if t == "claim_review":
        if claim_id is None:
            return ["Add claimed contributions in Step 1 first"]
        r = (v or {}).get(claim_id) or {}
        if not r.get("support"):
            return ["Say whether this claim is supported"]
        if r["support"] != "Fully" and not (r.get("missing") or "").strip():
            return ["Note what's missing"]
        return []
    if t == "pcs_choice":
        out = [] if pcs_value(state, q["field"]) else ["Choose a rating"]
        if q["field"] == "references" and pcs_value(state, "references") in ("Some References Missing", "No"):
            refs = [r for r in (answer_value(state, "s6_refs") or []) if (r.get("citation") or "").strip()]
            if not refs:
                out.append("List at least one missing reference first")
        return out
    if t == "pcs_text":
        return [] if (pcs_value(state, q["field"]) or "").strip() else ["Write or assemble the text"]
    if t == "ledger_strengths":
        kept = [i for i in active_ledger(state, "strength") if i.get("keep")]
        return [] if kept else ["Keep at least one strength (add one if you have none yet)"]
    if t == "ledger_majors":
        bad = [i for i in active_ledger(state, "major") if major_missing(i, flow)]
        return ["Complete %d major concern(s): what, where, why, fix, feasibility" % len(bad)] if bad else []
    if t == "checks":
        unresolved = [c for c in run_checks(state, form, flow) if c["id"] not in state.get("check_resolutions", {})]
        return ["Tick or dismiss %d check(s)" % len(unresolved)] if unresolved else []
    return []


def build_pages(state, step):
    pages = []
    group_pos = {}
    for q in visible_questions(state, step):
        if q["type"] == "claim_review":
            for c in claims(state):
                pages.append({"key": "%s:%s" % (q["id"], c["id"]), "qids": [q["id"]], "claim_id": c["id"]})
            if not claims(state):
                pages.append({"key": q["id"], "qids": [q["id"]], "claim_id": None})
            continue
        g = q.get("group")
        if g and g in group_pos:
            pages[group_pos[g]]["qids"].append(q["id"])
            continue
        if g:
            group_pos[g] = len(pages)
        pages.append({"key": q["id"], "qids": [q["id"]], "claim_id": None})
    return pages


def step_last_edit(state, step, flow, form):
    times = [a.get("updated_at") for a in state.get("answers", {}).values() if a.get("step") == step["id"]]
    times += [i.get("updated_at") for i in state.get("ledger", []) if i.get("source_step") == step["id"]]
    for q in step["questions"]:
        if q["type"] in ("pcs_choice", "pcs_text"):
            times.append((state.get("pcs", {}).get(q["field"]) or {}).get("updated_at"))
    if step["id"] == "s0":
        times.append(state.get("meta", {}).get("edited_at"))
    return max([t for t in times if t] or [""])


def evaluate(state, form, flow):
    qidx = question_index(flow)
    steps_out = []
    by_id = {}
    for step in flow["steps"]:
        applies = step_applies(state, step)
        pages = build_pages(state, step) if applies else []
        evidence_missing = False
        for p in pages:
            p["missing"] = []
            p["locked"] = False
            p["lock_reason"] = ""
            for qid in p["qids"]:
                q = qidx[qid][1]
                if q["type"] in DECISION_TYPES and evidence_missing and not p["locked"]:
                    p["locked"] = True
                    p["lock_reason"] = "Answer the questions before this one first: evidence comes before judgment."
                if q["type"] == "sheet":
                    unresolved = missing_for(state, qidx["s12_checks"][1], form, flow)
                    if unresolved:
                        p["locked"] = True
                        p["lock_reason"] = "Resolve every consistency check first."
                m = missing_for(state, q, form, flow, p["claim_id"]) if is_required(q) else []
                p["missing"] += m
            for qid in p["qids"]:
                q = qidx[qid][1]
                if q["type"] not in DECISION_TYPES and is_required(q) and p["missing"]:
                    evidence_missing = True
        complete = applies and all(not p["missing"] for p in pages)
        meta = state.get("step_meta", {}).get(step["id"], {})
        last = step_last_edit(state, step, flow, form)
        if not applies:
            status = "skipped"
        elif meta.get("completed_at") and complete:
            status = "done"
        elif last or meta.get("visited"):
            status = "in_progress"
        else:
            status = "not_started"
        steps_out.append({
            "id": step["id"],
            "title": step["title"],
            "feeds": step.get("feeds", []),
            "applies": applies,
            "pages": pages,
            "complete": complete,
            "status": status,
            "last_edit": last,
        })
        by_id[step["id"]] = steps_out[-1]

    # "needs re-check": completed, but a dependency was edited afterwards.
    for step in flow["steps"]:
        s = by_id[step["id"]]
        done_at = state.get("step_meta", {}).get(step["id"], {}).get("completed_at")
        if s["status"] != "done" or not done_at:
            continue
        stale = [d for d in step.get("depends_on", []) if by_id[d]["applies"] and by_id[d]["last_edit"] > done_at]
        if stale:
            s["status"] = "needs_recheck"
            s["stale_because"] = stale

    checks = run_checks(state, form, flow)
    filled = sum(1 for f in form["fields"] if (pcs_value(state, f["id"]) or "") != "")
    return {
        "steps": steps_out,
        "checks": checks,
        "pcs_filled": filled,
        "pcs_total": len(form["fields"]),
        "suggestions": {"demographics": suggest_demographics(state, form)},
        "review_words": word_count(pcs_value(state, "review") or ""),
    }


# --------------------------------------------------------------------------
# Consistency checks


def word_count(text):
    return len(re.findall(r"\S+", text or ""))


def paragraph_count(text):
    return len([p for p in re.split(r"\n\s*\n", (text or "").strip()) if p.strip()])


def _find_terms(text, terms):
    t = (text or "").lower()
    found = []
    for w in terms:
        if re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", t):
            found.append(w)
    return found


def rating_number(value):
    m = re.match(r"\s*(\d)", value or "")
    return int(m.group(1)) if m else None


def run_checks(state, form, flow):
    fields = form_fields(form)
    lex = flow["lexicons"]
    out = []

    def add(cid, step, message, severity="warn"):
        out.append({"id": cid, "step": step, "message": message, "severity": severity})

    owner = {}
    for step, q in iter_questions(flow):
        if q["type"] in ("pcs_choice", "pcs_text"):
            owner[q["field"]] = step["id"]

    for f in form["fields"]:
        if (pcs_value(state, f["id"]) or "") == "":
            add("unset:" + f["id"], owner.get(f["id"], "s12"), "“%s” isn't filled in yet." % f["heading"])

    screening = [q for q in flow["steps"][0]["questions"] if q["type"] == "check"]
    failed = [q["text"] for q in screening if (answer_value(state, q["id"]) or {}).get("status") == "no"]
    if failed:
        add("desk", "s0", "Desk-reject screening failed: %s Contact the coordinator or Paper Chairs." % " ".join(failed), "info")

    review = pcs_value(state, "review") or ""
    summary = pcs_value(state, "summary") or ""
    words, paras = word_count(review), paragraph_count(review)
    if review.strip() and (words < 400 or paras < 3):
        add("short", "s11", "The review is short (%d words, %d paragraphs). A high-quality review is typically about a page (~500–700 words); short or unjustified reviews are insufficient." % (words, paras))

    overall = rating_number(pcs_value(state, "overall"))
    majors = active_ledger(state, "major")
    minors = active_ledger(state, "minor")
    strengths_kept = [i for i in active_ledger(state, "strength") if i.get("keep")]
    if overall and overall >= 6:
        if (review.strip() and words < 400) or (not majors and not minors):
            add("high_thin", "s10", "A positive rating (%d) needs justification too: the review is short or lists only strengths." % overall)
        if len(strengths_kept) <= 2:
            add("high_few_strengths", "s10", "Rating %d, but only %d strength(s) written up." % (overall, len(strengths_kept)))
    if overall and overall <= 3 and not majors:
        add("low_no_majors", "s10", "Rating %d, but your ledger has no major concerns to justify it." % overall)
    if overall and overall >= 7 and len(majors) >= 3:
        add("high_many_majors", "s10", "Rating %d with %d unresolved major concerns: does the rating match the review?" % (overall, len(majors)))

    deadline = flow.get("submission_deadline", "")
    for i, r in enumerate(answer_value(state, "s6_refs") or []):
        if not (r.get("citation") or "").strip():
            continue
        label = (r["citation"][:60] + "…") if len(r["citation"]) > 60 else r["citation"]
        if not r.get("verified"):
            add("ref_unverified:%s" % r.get("id", i), "s6", "Reference not marked “verified it exists”: %s" % label)
        year = re.search(r"(19|20)\d\d", str(r.get("year") or ""))
        if year and deadline and int(year.group(0)) > int(deadline[:4]):
            add("ref_late:%s" % r.get("id", i), "s6", "Reference dated after the submission deadline (%s) can't count against the authors: %s" % (deadline, label))

    if pcs_value(state, "references") in ("Some References Missing", "No"):
        if not [r for r in (answer_value(state, "s6_refs") or []) if (r.get("citation") or "").strip()]:
            add("refs_empty", "s6", "References is “%s”, but no missing reference is listed." % pcs_value(state, "references"))

    if review.strip():
        for dim, kws in lex["dimensions"].items():
            if pcs_value(state, dim) and not any(k in review.lower() for k in kws):
                add("unmentioned:" + dim, "s11", "You rated “%s” but the review text doesn't seem to discuss it. The form asks you to justify each choice." % fields[dim]["heading"])

    humans = answer_value(state, "s1_humans")
    if humans == "yes":
        for fid in ("irb", "demographics", "diversity"):
            if pcs_value(state, fid) == fields[fid].get("na_option"):
                add("humans:" + fid, "s7", "The paper has human participants, but “%s” is “Not applicable”." % fields[fid]["heading"])

    for item in majors:
        if major_missing(item, flow):
            add("major_incomplete:" + str(item.get("id")), "s8", "Major concern not yet actionable: “%s”" % (item.get("what") or item.get("text") or "")[:80])

    texts = review + "\n" + summary
    for w in _find_terms(texts, lex["identity"]):
        add("identity:" + w, "s11", "Possible identity leak: “%s”. Reviews are anonymous." % w)
    for w in _find_terms(texts, lex["tone"]):
        add("tone:" + w, "s11", "Tone: “%s” can read as dismissive. Be constructive." % w)
    for w in _find_terms(review, lex["scope"]):
        add("scope:" + w, "s11", "“%s” may exceed the paper's scope or the ~1-month revision window. Keep expectations commensurate with the contribution." % w)
    nov = _find_terms(texts, lex["novelty"])
    if nov and overall and overall <= 4:
        add("novelty", "s11", "The review says “%s” and the rating is low. Replications are valuable; judge how the work fits related work and the field." % nov[0])
    return out


# --------------------------------------------------------------------------
# Composition: only the reviewer's own text, plus fixed labels.


def _bullets(lines, numbered=False):
    lines = [l for l in lines if l.strip()]
    if numbered:
        return "\n".join("%d. %s" % (i + 1, l) for i, l in enumerate(lines))
    return "\n".join("- " + l for l in lines)


def _with_loc(text, loc):
    text = (text or "").strip()
    loc = (loc or "").strip()
    return "%s (%s)" % (text, loc) if text and loc else text


def compose_section(state, key, form, flow):
    fields = form_fields(form)
    if key == "summary":
        para = " ".join(x.strip() for x in (answer_value(state, "s1_problem") or "", answer_value(state, "s1_approach") or "") if x.strip())
        cl = _bullets([c["text"].strip() for c in claims(state)])
        return "\n\n".join(p for p in (para, ("Claimed contributions:\n" + cl) if cl else "") if p)
    if key == "strengths":
        return _bullets([_with_loc(i.get("text"), i.get("location")) for i in active_ledger(state, "strength") if i.get("keep")])
    if key == "majors":
        blocks = []
        for n, i in enumerate(active_ledger(state, "major"), 1):
            head = _with_loc(i.get("what") or i.get("text"), i.get("where") or i.get("location"))
            lines = ["%d. %s" % (n, head)]
            if (i.get("why") or "").strip():
                lines.append("   " + i["why"].strip())
            if (i.get("fix") or "").strip():
                lines.append("   Possible fix: " + i["fix"].strip())
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)
    if key == "minors":
        return _bullets([_with_loc(i.get("text"), i.get("location")) for i in active_ledger(state, "minor")])
    if key == "dimensions":
        parts = []
        for fid, qid in (("soundness", "s3_just"), ("reproducibility", "s4_just"), ("clarity", "s5_just"), ("references", "s6_just")):
            just = (answer_value(state, qid) or "").strip()
            val = pcs_value(state, fid)
            if just or val:
                parts.append("%s%s: %s" % (fields[fid]["heading"], " (%s)" % val if val else "", just))
            if fid == "references":
                refs = [r for r in (answer_value(state, "s6_refs") or []) if (r.get("citation") or "").strip()]
                if refs:
                    parts.append("Missing references:\n" + _bullets([
                        r["citation"].strip() + (" — " + r["why"].strip() if (r.get("why") or "").strip() else "") for r in refs]))
        if answer_value(state, "s1_humans") == "yes":
            just = (answer_value(state, "s7_just") or "").strip()
            if just:
                parts.append("Ethics and participants: " + just)
        return "\n\n".join(parts)
    if key == "changes":
        fixes = [i.get("fix", "").strip() for i in active_ledger(state, "major") if (i.get("fix") or "").strip()]
        qs = [i.get("text", "").strip() for i in active_ledger(state, "question")]
        out = _bullets(fixes, numbered=True)
        if [q for q in qs if q]:
            out = "\n\n".join(p for p in (out, "Questions for the authors:\n" + _bullets(qs)) if p)
        return out
    if key == "rating":
        return (answer_value(state, "s10_just") or "").strip()
    raise ValueError("unknown section " + key)


def compose_summary(state, form, flow):
    para = " ".join(x.strip() for x in (answer_value(state, "s1_problem") or "", answer_value(state, "s1_approach") or "") if x.strip())
    parts = [para] if para else []
    cl = [c["text"].strip() for c in claims(state)]
    if cl:
        parts.append("Main contributions:\n" + _bullets(cl))
    st = [i.get("text", "").strip() for i in active_ledger(state, "strength") if i.get("keep")]
    if [s for s in st if s]:
        parts.append("Strengths:\n" + _bullets(st))
    wk = [(i.get("what") or i.get("text") or "").strip() for i in active_ledger(state, "major")]
    if [w for w in wk if w]:
        parts.append("Weaknesses:\n" + _bullets(wk))
    return "\n\n".join(parts)


def compose_review(state, form, flow):
    parts = []
    for sec in flow["review_sections"]:
        body = (answer_value(state, "s11_sec_" + sec["key"]) or "").strip()
        if body:
            parts.append(sec["label"] + "\n" + body)
    return "\n\n".join(parts)


def compose(state, kind, form, flow):
    if kind == "summary":
        return compose_summary(state, form, flow)
    if kind == "review":
        return compose_review(state, form, flow)
    if kind.startswith("section:"):
        return compose_section(state, kind.split(":", 1)[1], form, flow)
    raise ValueError("unknown compose kind " + kind)


# --------------------------------------------------------------------------
# Exports


def _fmt_value(v):
    if v is None or v == "":
        return "_(no answer)_"
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, list):
        if v and isinstance(v[0], dict):
            return "\n".join("- " + "; ".join("%s: %s" % (k, x) for k, x in i.items() if k != "id" and x not in ("", None)) for i in v)
        return ", ".join(str(x) for x in v)
    if isinstance(v, dict):
        if "status" in v:
            return v["status"] + (" (%s)" % v["note"] if (v.get("note") or "").strip() else "")
        return "\n".join("- %s: %s" % (k, _fmt_value(x)) for k, x in v.items())
    return str(v)


def pcs_text(state, form):
    blocks = []
    for f in form["fields"]:
        v = pcs_value(state, f["id"])
        blocks.append("%s\n%s" % (f["heading"], v if v not in (None, "") else "(not yet completed)"))
    return "\n\n".join(blocks) + "\n"


def empty_annotations():
    return {"version": 1, "highlights": [], "strokes": []}


def _comments(h, ts):
    out = []
    for c in h.get("comments") or []:
        if isinstance(c, dict) and str(c.get("text") or "").strip():
            item = {"id": str(c.get("id") or len(out)), "text": str(c["text"]).strip(), "created_at": c.get("created_at") or ts}
            if c.get("edited_at"):
                item["edited_at"] = c["edited_at"]
            out.append(item)
    # files from before comments existed stored a single `note`
    if not out and str(h.get("note") or "").strip():
        out.append({"id": "note", "text": str(h["note"]).strip(), "created_at": h.get("created_at") or ts})
    return out


def normalize_annotations(data, ts=None):
    """Keep only well-formed highlights and pen strokes; stamp updated_at."""
    out = empty_annotations()
    data = data if isinstance(data, dict) else {}

    def num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    for h in data.get("highlights") or []:
        if not isinstance(h, dict) or not h.get("id"):
            continue
        rects = [r for r in (h.get("rects") or []) if isinstance(r, dict) and all(num(r.get(k)) for k in ("p", "x", "y", "w", "h"))]
        if not rects:
            continue
        out["highlights"].append({
            "id": str(h["id"]), "page": int(rects[0]["p"]), "rects": rects,
            "color": str(h.get("color") or "yellow"), "text": str(h.get("text") or ""),
            "comments": _comments(h, ts), "created_at": h.get("created_at") or ts,
        })
    for st in data.get("strokes") or []:
        if not isinstance(st, dict) or not st.get("id"):
            continue
        pts = [p for p in (st.get("points") or []) if isinstance(p, list) and len(p) == 2 and all(num(v) for v in p)]
        if not pts or not num(st.get("page")):
            continue
        out["strokes"].append({
            "id": str(st["id"]), "page": int(st["page"]), "color": str(st.get("color") or "#e0262b"),
            "width": float(st["width"]) if num(st.get("width")) else 2.5, "points": pts,
            "created_at": st.get("created_at") or ts,
        })
    out["updated_at"] = ts or now_iso()
    return out


def _annotation_lines(annotations, flow):
    hl = sorted((annotations or {}).get("highlights") or [], key=lambda h: (h["page"], min(r["y"] for r in h["rects"])))
    strokes = (annotations or {}).get("strokes") or []
    if not hl and not strokes:
        return []
    labels = {c["id"]: c["label"] for c in flow.get("annotation", {}).get("highlight_colors", [])}
    lines = ["## PDF annotations", ""]
    for h in hl:
        quote = " ".join(h["text"].split())
        lines.append("- p. %d · %s · “%s”" % (h["page"], labels.get(h["color"], h["color"]), quote))
        for c in h.get("comments") or []:
            lines.append("  - Comment: %s" % " ".join(c["text"].split()))
    if strokes:
        pages = sorted({s["page"] for s in strokes})
        lines += ["", "Pen marks: %d stroke(s) on page(s) %s." % (len(strokes), ", ".join(map(str, pages)))]
    return lines + [""]


def export_markdown(state, form, flow, annotations=None):
    m = state.get("meta", {})
    lines = ["# Review: %s" % (m.get("title") or m.get("paper_id")), "",
             "Paper ID: %s · Role: %s · Updated: %s" % (m.get("paper_id"), m.get("role") or "-", m.get("updated_at")), "",
             "# PCS review form", ""]
    for f in form["fields"]:
        v = pcs_value(state, f["id"])
        lines += ["## %s" % f["heading"], "", v if v not in (None, "") else "_not yet completed_", ""]

    lines += ["---", "", "# Working notes: do NOT paste into PCS", ""]
    qidx = question_index(flow)
    grouped = {f["heading"]: [] for f in form["fields"]}
    general = []
    for step, q in iter_questions(flow):
        a = state.get("answers", {}).get(q["id"])
        if not a:
            continue
        v = a.get("value")
        if q["type"] == "claim_review":
            names = {c["id"]: c["text"] for c in claims(state)}
            v = {names.get(k, k): "%s%s" % (r.get("support", ""), " (%s)" % r["missing"] if r.get("missing") else "") for k, r in (v or {}).items()}
        entry = "**%s · %s**\n\n%s\n" % (step["title"], q["text"], _fmt_value(v))
        heads = a.get("pcs_headings") or []
        if heads:
            grouped.setdefault(heads[0], []).append(entry)
        else:
            general.append(entry)
    if general:
        lines += ["## Paper setup and understanding", ""] + general
    for head, entries in grouped.items():
        if entries:
            lines += ["## %s" % head, ""] + entries

    lines += ["## Findings ledger", ""]
    for t in LEDGER_TYPES:
        items = active_ledger(state, t)
        if not items:
            continue
        lines += ["### %s" % {"strength": "Strengths", "major": "Major concerns", "minor": "Minor concerns", "question": "Questions for authors"}[t], ""]
        for i in items:
            detail = "; ".join("%s: %s" % (k, i[k]) for k in ("dimension", "location", "what", "where", "why", "fix", "feasible") if i.get(k))
            lines.append("- %s%s" % (i.get("text") or i.get("what") or "", " _(%s)_" % detail if detail else ""))
        lines.append("")
    dropped = [i for i in state.get("ledger", []) if i.get("dropped")]
    if dropped:
        lines += ["### Dropped", ""] + ["- ~~%s~~" % (i.get("text") or i.get("what") or "") for i in dropped] + [""]
    lines += _annotation_lines(annotations, flow)
    return "\n".join(lines).rstrip() + "\n"


# --------------------------------------------------------------------------
# Storage


class Store:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def paper_dir(self, pid):
        return os.path.join(self.root, pid)

    def json_path(self, pid):
        return os.path.join(self.paper_dir(pid), "review.json")

    def exists(self, pid):
        return os.path.exists(self.json_path(pid))

    def list(self):
        out = []
        for name in sorted(os.listdir(self.root)):
            p = self.json_path(name)
            if os.path.isfile(p):
                try:
                    s = load_json(p)
                except (OSError, ValueError):
                    continue
                out.append(s)
        return out

    def load(self, pid):
        return load_json(self.json_path(pid))

    def save(self, state, form, flow, force_backup=False):
        pid = state["meta"]["paper_id"]
        d = self.paper_dir(pid)
        os.makedirs(d, exist_ok=True)
        jp = self.json_path(pid)
        if os.path.exists(jp):
            self._backup(pid, force_backup)
        atomic_write(jp, json.dumps(state, indent=2, ensure_ascii=False) + "\n")
        atomic_write(os.path.join(d, "review.md"), export_markdown(state, form, flow, self.load_annotations(pid)))

    def annotations_path(self, pid):
        return os.path.join(self.paper_dir(pid), "annotations.json")

    def load_annotations(self, pid):
        p = self.annotations_path(pid)
        if not os.path.isfile(p):
            return empty_annotations()
        try:
            return load_json(p)
        except (OSError, ValueError):
            return empty_annotations()

    def save_annotations(self, pid, data, form, flow):
        ann = normalize_annotations(data)
        atomic_write(self.annotations_path(pid), json.dumps(ann, indent=1, ensure_ascii=False) + "\n")
        if self.exists(pid):  # keep review.md's annotation section current
            md = export_markdown(self.load(pid), form, flow, ann)
            atomic_write(os.path.join(self.paper_dir(pid), "review.md"), md)
        return ann

    def annotated_pdf_path(self, pid):
        return os.path.join(self.paper_dir(pid), "annotated.pdf")

    def save_annotated_pdf(self, pid, data):
        if not data.startswith(b"%PDF-"):
            raise ValueError("not a PDF")
        atomic_write_bytes(self.annotated_pdf_path(pid), data)

    def backups(self, pid):
        bd = os.path.join(self.paper_dir(pid), "backups")
        if not os.path.isdir(bd):
            return []
        return sorted(f for f in os.listdir(bd) if f.startswith("review-") and f.endswith(".json"))

    def _backup(self, pid, force):
        bd = os.path.join(self.paper_dir(pid), "backups")
        os.makedirs(bd, exist_ok=True)
        existing = self.backups(pid)
        if existing and not force:
            last = os.path.getmtime(os.path.join(bd, existing[-1]))
            if datetime.now().timestamp() - last < BACKUP_MIN_INTERVAL_S:
                return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(self.json_path(pid), os.path.join(bd, "review-%s.json" % stamp))
        for old in self.backups(pid)[:-MAX_BACKUPS]:
            os.remove(os.path.join(bd, old))


def atomic_write(path, text):
    atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_bytes(path, data):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
