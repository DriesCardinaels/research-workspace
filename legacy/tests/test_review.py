import copy
import json
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import review_core as core  # noqa: E402

FORM, FLOW = core.load_config()


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def fresh(pid="t1"):
    return core.apply_update(None, core.new_state(pid, FORM, "A Paper"), FORM, FLOW, ts="2026-10-14T10:00:00.000+00:00")


def put(state, mutate, ts):
    new = copy.deepcopy(state)
    mutate(new)
    return core.apply_update(state, new, FORM, FLOW, ts=ts)


def ans(s, qid, value):
    s["answers"][qid] = {"value": value}


def step(ev, sid):
    return next(x for x in ev["steps"] if x["id"] == sid)


def page(ev, sid, key):
    return next(p for p in step(ev, sid)["pages"] if p["key"] == key)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = core.Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_and_resume(self):
        s = fresh()
        s = put(s, lambda n: (ans(n, "s1_problem", "Locomotion sickness"), n.update(current={"step": "s3", "page": 2})), "2026-10-14T10:01:00.000+00:00")
        self.store.save(s, FORM, FLOW)
        loaded = self.store.load("t1")
        self.assertEqual(loaded, s)
        self.assertEqual(loaded["current"], {"step": "s3", "page": 2})
        a = loaded["answers"]["s1_problem"]
        self.assertEqual(a["question"], "In one or two sentences, what problem does the paper address?")
        self.assertIn("Summary of Contributions", a["pcs_headings"])
        self.assertTrue(os.path.exists(os.path.join(self.tmp.name, "t1", "review.md")))

    def test_atomic_write_keeps_original_on_failure(self):
        s = fresh()
        self.store.save(s, FORM, FLOW)
        path = self.store.json_path("t1")
        before = read(path)
        s2 = put(s, lambda n: ans(n, "s1_problem", "changed"), "2026-10-14T10:02:00.000+00:00")
        with mock.patch("review_core.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.store.save(s2, FORM, FLOW, force_backup=True)
        self.assertEqual(read(path), before)
        leftovers = [f for f in os.listdir(os.path.dirname(path)) if f.startswith(".tmp-")]
        self.assertEqual(leftovers, [])

    def test_backup_rotation_keeps_ten(self):
        s = fresh()
        for i in range(14):
            s = put(s, lambda n, i=i: ans(n, "s1_problem", "v%d" % i), "2026-10-14T10:%02d:00.000+00:00" % (i + 3))
            self.store.save(s, FORM, FLOW, force_backup=True)
        self.assertEqual(len(self.store.backups("t1")), core.MAX_BACKUPS)

    def test_backups_are_throttled_without_force(self):
        s = fresh()
        for i in range(5):
            s = put(s, lambda n, i=i: ans(n, "s1_problem", "v%d" % i), "2026-10-14T11:%02d:00.000+00:00" % i)
            self.store.save(s, FORM, FLOW)
        self.assertEqual(len(self.store.backups("t1")), 1)


class ExportTests(unittest.TestCase):
    def test_markdown_pcs_order_and_headings(self):
        s = fresh()
        s = put(s, lambda n: (n["pcs"]["clarity"].update(value="Good"), ans(n, "s5_just", "Clear writing.")), "2026-10-14T10:05:00.000+00:00")
        md = core.export_markdown(s, FORM, FLOW)
        pcs_part, notes = md.split("# Working notes: do NOT paste into PCS")
        heads = re.findall(r"^## (.+)$", pcs_part, re.M)
        self.assertEqual(heads, [f["heading"] for f in FORM["fields"]])
        self.assertIn("## Clarity of Presentation\n\nGood\n", pcs_part)
        self.assertIn("_not yet completed_", pcs_part)
        self.assertIn("## Clarity of Presentation", notes)
        self.assertIn("Clear writing.", notes)

    def test_pcs_text_has_every_heading(self):
        txt = core.pcs_text(fresh(), FORM)
        for f in FORM["fields"]:
            self.assertIn(f["heading"] + "\n", txt)


class GatingTests(unittest.TestCase):
    def test_rating_locked_until_evidence_answered(self):
        s = fresh()
        ev = core.evaluate(s, FORM, FLOW)
        self.assertTrue(page(ev, "s4", "s4_pcs")["locked"])
        self.assertTrue(page(ev, "s4", "s4_just")["locked"])

        def answer_all(n):
            for q in ("s4_hardware", "s4_apparatus", "s4_analysis", "s4_materials", "s4_standalone"):
                ans(n, q, {"status": "yes", "note": ""})
            ans(n, "s1_humans", "no")
        s = put(s, answer_all, "2026-10-14T10:06:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertFalse(page(ev, "s4", "s4_pcs")["locked"])
        self.assertEqual(page(ev, "s4", "s4_pcs")["missing"], ["Choose a rating"])

    def test_unsure_requires_reason(self):
        s = put(fresh(), lambda n: ans(n, "s0_template", {"status": "unsure", "note": ""}), "2026-10-14T10:07:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertTrue(page(ev, "s0", "s0_template")["missing"])

    def test_step7_auto_skips_without_humans(self):
        s = put(fresh(), lambda n: ans(n, "s1_humans", "no"), "2026-10-14T10:08:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertEqual(step(ev, "s7")["status"], "skipped")
        self.assertEqual(step(ev, "s7")["pages"], [])
        for fid in ("irb", "demographics", "diversity"):
            self.assertEqual(s["pcs"][fid]["value"], "Not applicable (No experiment with human participants)")

    def test_step7_applies_with_humans(self):
        s = put(fresh(), lambda n: ans(n, "s1_humans", "yes"), "2026-10-14T10:08:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertTrue(step(ev, "s7")["applies"])
        self.assertIn("s3_design", [p["key"] for p in step(ev, "s3")["pages"]])

    def test_references_missing_requires_a_listed_reference(self):
        s = put(fresh(), lambda n: n["pcs"]["references"].update(value="Some References Missing"), "2026-10-14T10:09:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertIn("List at least one missing reference first", page(ev, "s6", "s6_pcs")["missing"])
        s = put(s, lambda n: ans(n, "s6_refs", [{"id": "r1", "citation": "Smith 2020", "year": "2020", "why": "x", "verified": True}]), "2026-10-14T10:10:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertEqual(page(ev, "s6", "s6_pcs")["missing"], [])

    def test_claims_expand_to_one_page_each(self):
        claims = [{"id": "c1", "text": "A"}, {"id": "c2", "text": "B"}]
        s = put(fresh(), lambda n: (ans(n, "s1_claims", claims), ans(n, "s3_claims", {"c1": {"support": "Partially", "missing": ""}})), "2026-10-14T10:11:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertEqual(page(ev, "s3", "s3_claims:c1")["missing"], ["Note what's missing"])
        self.assertEqual(page(ev, "s3", "s3_claims:c2")["missing"], ["Say whether this claim is supported"])

    def test_major_concerns_must_be_actionable(self):
        item = {"id": "m1", "type": "major", "text": "Small sample", "what": "Small sample", "where": "", "why": "", "fix": "", "feasible": ""}
        s = put(fresh(), lambda n: n["ledger"].append(item), "2026-10-14T10:12:00.000+00:00")
        ev = core.evaluate(s, FORM, FLOW)
        self.assertTrue(page(ev, "s8", "s8_majors")["missing"])
        s = put(s, lambda n: n["ledger"][0].update(where="Sec 4", why="Underpowered", fix="Report power analysis", feasible="Yes"), "2026-10-14T10:13:00.000+00:00")
        self.assertEqual(page(core.evaluate(s, FORM, FLOW), "s8", "s8_majors")["missing"], [])

    def test_sheet_locked_until_checks_resolved(self):
        s = fresh()
        ev = core.evaluate(s, FORM, FLOW)
        self.assertTrue(page(ev, "s12", "s12_sheet")["locked"])
        s = put(s, lambda n: n["check_resolutions"].update({c["id"]: "dismissed" for c in ev["checks"]}), "2026-10-14T10:14:00.000+00:00")
        self.assertFalse(page(core.evaluate(s, FORM, FLOW), "s12", "s12_sheet")["locked"])


class RecheckTests(unittest.TestCase):
    def test_editing_a_dependency_marks_step_for_recheck(self):
        s = fresh()

        def do_s4(n):
            ans(n, "s1_humans", "no")
            for q in ("s4_hardware", "s4_apparatus", "s4_analysis", "s4_materials", "s4_standalone"):
                ans(n, q, {"status": "yes"})
            n["pcs"]["reproducibility"]["value"] = "Yes"
            ans(n, "s4_just", "Everything is described.")
            n["step_meta"]["s4"] = {"complete": True}
        s = put(s, do_s4, "2026-10-14T10:20:00.000+00:00")
        self.assertEqual(step(core.evaluate(s, FORM, FLOW), "s4")["status"], "done")
        self.assertNotIn("complete", s["step_meta"]["s4"])

        s = put(s, lambda n: ans(n, "s1_problem", "Reframed problem"), "2026-10-14T10:25:00.000+00:00")
        st = step(core.evaluate(s, FORM, FLOW), "s4")
        self.assertEqual(st["status"], "needs_recheck")
        self.assertEqual(st["stale_because"], ["s1"])

        s = put(s, lambda n: n["step_meta"]["s4"].update(complete=True), "2026-10-14T10:30:00.000+00:00")
        self.assertEqual(step(core.evaluate(s, FORM, FLOW), "s4")["status"], "done")

    def test_unchanged_answers_keep_timestamps(self):
        s = put(fresh(), lambda n: ans(n, "s1_problem", "P"), "2026-10-14T10:40:00.000+00:00")
        s2 = put(s, lambda n: ans(n, "s1_approach", "A"), "2026-10-14T10:41:00.000+00:00")
        self.assertEqual(s2["answers"]["s1_problem"]["updated_at"], "2026-10-14T10:40:00.000+00:00")
        self.assertEqual(s2["answers"]["s1_approach"]["updated_at"], "2026-10-14T10:41:00.000+00:00")


class ComposeTests(unittest.TestCase):
    """Drafts may only contain the reviewer's own text plus fixed labels."""

    LABELS = ["Claimed contributions:", "Main contributions:", "Strengths:", "Weaknesses:", "Possible fix:",
              "Missing references:", "Questions for the authors:", "Ethics and participants:"]

    def build(self):
        def m(n):
            ans(n, "s1_problem", "UP1 problem text.")
            ans(n, "s1_approach", "UP2 approach text.")
            ans(n, "s1_claims", [{"id": "c1", "text": "UC1 claim one"}, {"id": "c2", "text": "UC2 claim two"}])
            ans(n, "s1_humans", "yes")
            ans(n, "s3_just", "UJ3 soundness justification.")
            ans(n, "s4_just", "UJ4 repro justification.")
            ans(n, "s5_just", "UJ5 clarity justification.")
            ans(n, "s6_just", "UJ6 refs justification.")
            ans(n, "s6_refs", [{"id": "r", "citation": "UR1 Doe 2019", "why": "UR2 relevant", "verified": True}])
            ans(n, "s7_just", "UJ7 ethics justification.")
            ans(n, "s10_just", "UJ10 rating justification.")
            n["pcs"]["soundness"]["value"] = "Good"
            n["pcs"]["clarity"]["value"] = "Excellent"
            n["ledger"] += [
                {"id": "a", "type": "strength", "text": "US1 strength", "keep": True, "rank": 0, "location": "UL1 sec 3"},
                {"id": "b", "type": "strength", "text": "US2 not kept", "keep": False},
                {"id": "c", "type": "major", "text": "UM0", "what": "UM1 what", "where": "UM2 where", "why": "UM3 why", "fix": "UM4 fix", "feasible": "Yes"},
                {"id": "d", "type": "minor", "text": "UN1 minor"},
                {"id": "e", "type": "question", "text": "UQ1 question"},
                {"id": "f", "type": "major", "text": "UX dropped", "dropped": True},
            ]
        return put(fresh(), m, "2026-10-14T10:50:00.000+00:00")

    def user_strings(self, s):
        out = []

        def walk(v):
            if isinstance(v, str):
                out.append(v)
            elif isinstance(v, dict):
                for k, x in v.items():
                    if k not in ("id", "type", "feasible"):
                        walk(x)
            elif isinstance(v, list):
                for x in v:
                    walk(x)
        walk({k: a["value"] for k, a in s["answers"].items()})
        walk(s["ledger"])
        out += [f["value"] for f in s["pcs"].values() if isinstance(f["value"], str)]
        out += [f["heading"] for f in FORM["fields"]]
        return sorted(set(o for o in out if o), key=len, reverse=True)

    def residue(self, text, s):
        for u in self.user_strings(s) + self.LABELS + [sec["label"] for sec in FLOW["review_sections"]]:
            text = text.replace(u, "")
        return re.sub(r"[\s\-\d\.\(\):—/]+", "", text)

    def test_sections_and_summary_contain_only_user_text(self):
        s = self.build()
        for sec in FLOW["review_sections"]:
            text = core.compose(s, "section:" + sec["key"], FORM, FLOW)
            self.assertEqual(self.residue(text, s), "", sec["key"])
        self.assertEqual(self.residue(core.compose(s, "summary", FORM, FLOW), s), "")

    def test_compose_content(self):
        s = self.build()
        summary = core.compose(s, "summary", FORM, FLOW)
        self.assertIn("US1 strength", summary)
        self.assertNotIn("US2 not kept", summary)
        self.assertIn("UM1 what", summary)
        majors = core.compose(s, "section:majors", FORM, FLOW)
        self.assertNotIn("UX dropped", majors)
        self.assertIn("Possible fix: UM4 fix", majors)
        dims = core.compose(s, "section:dimensions", FORM, FLOW)
        self.assertIn("Technical Soundness (Good): UJ3", dims)
        self.assertIn("UR1 Doe 2019", dims)
        self.assertIn("UJ7", dims)

    def test_review_joins_user_sections_in_order(self):
        s = put(self.build(), lambda n: (ans(n, "s11_sec_summary", "SUM"), ans(n, "s11_sec_rating", "RAT")), "2026-10-14T10:51:00.000+00:00")
        self.assertEqual(core.compose(s, "review", FORM, FLOW), "Summary\nSUM\n\nJustification of overall rating\nRAT")


class CheckTests(unittest.TestCase):
    def ids(self, s):
        return {c["id"] for c in core.run_checks(s, FORM, FLOW)}

    def test_fresh_state_flags_unset_fields(self):
        ids = self.ids(fresh())
        self.assertEqual({i for i in ids if i.startswith("unset:")}, {"unset:" + f["id"] for f in FORM["fields"]})

    def test_review_text_checks(self):
        review = "Summary\nThis is obviously trivial. In our lab we did this. The authors should run a new study. It is not novel."
        s = put(fresh(), lambda n: (n["pcs"]["review"].update(value=review), n["pcs"]["overall"].update(value="2 - Reject"),
                                    n["pcs"]["clarity"].update(value="Good")), "2026-10-14T11:00:00.000+00:00")
        ids = self.ids(s)
        for expected in ("short", "tone:obviously", "tone:trivial", "identity:our lab", "scope:new study", "novelty",
                         "unmentioned:clarity", "low_no_majors"):
            self.assertIn(expected, ids)

    def test_rating_ledger_mismatch(self):
        majors = [{"id": str(i), "type": "major", "text": "x"} for i in range(3)]
        s = put(fresh(), lambda n: (n["pcs"]["overall"].update(value="8 - Definite accept"), n["ledger"].extend(majors)), "2026-10-14T11:01:00.000+00:00")
        ids = self.ids(s)
        self.assertIn("high_many_majors", ids)
        self.assertIn("high_few_strengths", ids)

    def test_reference_checks(self):
        refs = [{"id": "r1", "citation": "Late 2027", "year": "2027", "verified": False}]
        s = put(fresh(), lambda n: ans(n, "s6_refs", refs), "2026-10-14T11:02:00.000+00:00")
        ids = self.ids(s)
        self.assertIn("ref_unverified:r1", ids)
        self.assertIn("ref_late:r1", ids)

    def test_humans_inconsistency(self):
        na = "Not applicable (No experiment with human participants)"
        s = put(fresh(), lambda n: (ans(n, "s1_humans", "yes"), n["pcs"]["irb"].update(value=na)), "2026-10-14T11:03:00.000+00:00")
        self.assertIn("humans:irb", self.ids(s))

    def test_word_boundaries_avoid_false_positives(self):
        s = put(fresh(), lambda n: n["pcs"]["review"].update(value="Our laboratory-grade apparatus is not trivially reproducible."), "2026-10-14T11:04:00.000+00:00")
        ids = self.ids(s)
        self.assertNotIn("tone:trivial", ids)
        self.assertNotIn("identity:our lab", ids)

    def test_demographics_suggestion(self):
        s = put(fresh(), lambda n: ans(n, "s7_demo_items", ["Number of participants (N)", "Age (mean/SD/range)", "Gender", "Recruitment procedure", "Compensation"]), "2026-10-14T11:05:00.000+00:00")
        self.assertEqual(core.suggest_demographics(s, FORM), "Participant demographics are clearly and adequately reported.")
        s = put(s, lambda n: ans(n, "s7_demo_items", ["Gender"]), "2026-10-14T11:06:00.000+00:00")
        self.assertEqual(core.suggest_demographics(s, FORM), "Participant demographics are minimally reported.")


class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = core.Store(self.tmp.name)
        self.store.save(fresh(), FORM, FLOW)

    def tearDown(self):
        self.tmp.cleanup()

    def sample(self):
        return {
            "highlights": [
                {"id": "h1", "color": "pink", "text": "we  claim\nmitigation", "note": "Overclaimed",
                 "rects": [{"p": 2, "x": 50, "y": 400, "w": 200, "h": 10}, {"p": 2, "x": 50, "y": 410, "w": 120, "h": 10}]},
                {"id": "h0", "color": "green", "text": "Nice study", "rects": [{"p": 1, "x": 10, "y": 10, "w": 5, "h": 5}],
                 "comments": [{"id": "c1", "text": "Well powered", "created_at": "A"}, {"id": "c2", "text": "  "},
                              {"id": "c3", "text": "Second  thought", "edited_at": "B"}, "junk"]},
                {"id": "bad", "color": "pink", "rects": [{"p": 1, "x": "nope"}]},
                "garbage",
            ],
            "strokes": [
                {"id": "s1", "page": 1, "color": "#e0262b", "width": 2.5, "points": [[1, 2], [3, 4]]},
                {"id": "s2", "page": 3, "points": [[1, 2], ["x", 4]]},
                {"id": "s3", "points": [[1, 2]]},
            ],
        }

    def test_normalize_drops_malformed_items(self):
        ann = core.normalize_annotations(self.sample(), ts="T")
        self.assertEqual([h["id"] for h in ann["highlights"]], ["h1", "h0"])
        self.assertEqual(ann["highlights"][0]["page"], 2)
        self.assertEqual([s["id"] for s in ann["strokes"]], ["s1", "s2"])
        self.assertEqual(ann["strokes"][1]["points"], [[1, 2]])
        self.assertEqual(ann["strokes"][1]["width"], 2.5)
        self.assertEqual(core.normalize_annotations("nonsense")["highlights"], [])

    def test_comments_kept_and_old_note_migrated(self):
        ann = core.normalize_annotations(self.sample(), ts="T")
        h1, h0 = ann["highlights"]
        self.assertEqual([c["text"] for c in h1["comments"]], ["Overclaimed"])  # legacy `note`
        self.assertNotIn("note", h1)
        self.assertEqual([(c["id"], c["text"]) for c in h0["comments"]], [("c1", "Well powered"), ("c3", "Second  thought")])
        self.assertEqual(h0["comments"][1]["edited_at"], "B")

    def test_save_load_and_markdown_section(self):
        self.store.save_annotations("t1", self.sample(), FORM, FLOW)
        self.assertEqual(len(self.store.load_annotations("t1")["highlights"]), 2)
        md = read(os.path.join(self.tmp.name, "t1", "review.md"))
        notes = md.split("# Working notes: do NOT paste into PCS")[1]
        self.assertIn("## PDF annotations", notes)
        # sorted by page, color label from flow.json, whitespace collapsed, note kept
        self.assertLess(notes.index("p. 1 · Strength"), notes.index("p. 2 · Concern"))
        self.assertIn("“we claim mitigation”", notes)
        self.assertIn("  - Comment: Overclaimed", notes)
        self.assertIn("  - Comment: Second thought", notes)
        self.assertIn("Pen marks: 2 stroke(s) on page(s) 1, 3.", notes)
        # a later review save keeps the annotation section
        self.store.save(fresh(), FORM, FLOW)
        self.assertIn("## PDF annotations", read(os.path.join(self.tmp.name, "t1", "review.md")))

    def test_no_annotations_no_section(self):
        self.assertNotIn("PDF annotations", core.export_markdown(fresh(), FORM, FLOW, core.empty_annotations()))
        self.assertEqual(self.store.load_annotations("t1"), core.empty_annotations())

    def test_annotated_pdf_must_be_a_pdf(self):
        with self.assertRaises(ValueError):
            self.store.save_annotated_pdf("t1", b"<html>")
        self.store.save_annotated_pdf("t1", b"%PDF-1.7 fake")
        with open(self.store.annotated_pdf_path("t1"), "rb") as f:
            self.assertEqual(f.read(), b"%PDF-1.7 fake")

    def test_highlight_colors_map_to_ledger_types(self):
        types = {c["ledger"] for c in FLOW["annotation"]["highlight_colors"]} - {None}
        self.assertLessEqual(types, set(core.LEDGER_TYPES))


class ConfigTests(unittest.TestCase):
    def test_flow_references_valid_fields_and_steps(self):
        fields = {f["id"] for f in FORM["fields"]}
        ids = [s["id"] for s in FLOW["steps"]]
        qids = set()
        for st in FLOW["steps"]:
            for d in st.get("depends_on", []):
                self.assertIn(d, ids)
            for f in st.get("feeds", []):
                self.assertIn(f, fields)
            for q in st["questions"]:
                self.assertNotIn(q["id"], qids)
                qids.add(q["id"])
                if "field" in q:
                    self.assertIn(q["field"], fields)
        fed = {q["field"] for _, q in core.iter_questions(FLOW) if q["type"] in ("pcs_choice", "pcs_text")}
        self.assertEqual(fed, fields, "every PCS field must be built by exactly one step")


if __name__ == "__main__":
    unittest.main()
