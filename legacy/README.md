> Archived implementation: this directory is independent of the active Research
> Workbench application and is not an extension location for its tools or editors.

## Maintenance guide

The build prompt below is historical documentation, not current implementation
instructions. See [USAGE.md](USAGE.md) for the archived application's operation.
`review_core.py` owns review state and workflow rules, `review_helper.py` owns its
local server, and `flow.json`/`form_schema.json` define its review configuration.
The active application must not import these modules or serve this directory.

For a deliberate legacy-only fix, keep it here, preserve stored reviews and offline
behavior, update USAGE when needed, and run
`python3 -m unittest discover -s legacy/tests -v` from the repository root.
[tests/README.md](tests/README.md) explains fixture conventions. New Research
Workbench features belong in the [active extension guide](../static/README.md).

---

# Review Helper: Build Prompt

This README holds a prompt for **Claude Opus 5.5**. Paste everything inside the
fenced block below into a fresh Claude Code session started in this folder. It
builds a small local tool that walks you through reviewing one IEEE VR 2027
paper and saves every answer, keyed by its form heading, to a file.

Sources the guidance is based on:
- IEEE VR 2027 Call for Papers: https://ieeevr.org/2027/contribute/papers/ (primary source)
- CHI 2027 Papers: https://chi2027.acm.org/authors/papers/ (extra reviewing knowledge)
- CHI Guide to Reviewing Papers: https://chi2025.acm.org/guide-to-reviewing-papers/ (reviewing practice)
- The IEEE VR 2027 review form in PCS (fields copied below)

---

````text
# Task

Build "Review Helper": a small, local, offline tool that helps me write one
detailed peer review of one paper submitted to IEEE VR 2027 (papers track).
The tool is a **guided, sequential review coach**. It interviews me step by
step, from understanding the paper, through assessing each dimension, to
synthesis, rating, and writing. Along the way it builds each answer the PCS
review form needs from the evidence I've gathered. It doesn't present the
form as a set of fields to fill in and copy. See "Core idea" below; that
section is the heart of this spec. Everything I type is saved to disk, with
each answer linked to the question it answers and the PCS heading it feeds.
I write the review myself. The tool never generates review text.

Work in the current directory. When you're done, the tool should run with one
command. At the end of the guided flow I should have a complete, polished
PCS sheet I can paste field by field into the PCS review form.

## Hard constraints

1. **Confidentiality.** Submissions under review are confidential. The tool
   must run fully offline: no network calls, no CDNs, no analytics, no LLM or
   API calls, no telemetry. Nothing about the paper or my review leaves this
   machine. Also say this in the tool's own README.
2. **Zero or near-zero dependencies.** Use Python 3 standard library only:
   `http.server` for a tiny local server and one self-contained HTML/CSS/JS
   page served from it. No npm and no pip installs. Start it with
   `python3 review_helper.py [path/to/paper.pdf]`, which opens the browser at
   `http://127.0.0.1:<port>`. Bind to 127.0.0.1 only.
3. **Every input is persisted, linked to its heading.** Autosave on change
   (debounced, about 500 ms) plus an explicit "Save" button. Never lose input:
   write to a temp file and rename it into place atomically, and keep the last
   10 timestamped backups in `reviews/<paper-id>/backups/`.
4. **Two output files per paper**, both in `reviews/<paper-id>/`:
   - `review.json`: the source of truth. It holds the final PCS fields (each
     with `heading` (exact form heading text), `field_id`, `type`
     (`text` | `choice`), `value`, `options`, `updated_at`), every step answer
     linked to its question text and PCS heading, the findings ledger, and
     the current step. Add top-level metadata: paper ID, title, my role
     (primary, secondary, or external reviewer), created and updated
     timestamps, and a schema version. See "Persistence details for the
     guided flow" below.
   - `review.md`: a human-readable export, regenerated on every save. The
     PCS fields come first, as `## <Heading>` blocks in **exactly the PCS
     form order**. Working notes follow in a clearly marked appendix.
   On startup, if `review.json` exists for the paper, load it and resume at
   the step where I left off.

## The official review form (the target the guided flow builds)

Use these exact headings, option labels, and helper texts. They mirror the
PCS form. Use this order only for the final PCS sheet in Step 12 and the
exports. Show each field's helper text on the step that fills it.

1. **Summary of Contributions** (long text)
   "Provide a short summary of the contents of the paper and the main
   contributions. In addition, provide the main strengths and weaknesses of
   the paper."
2. **Expertise** (single choice): Expert / Knowledgeable / Passing Knowledge
   "Provide your expertise in the topic area of this paper."
3. **Clarity of Presentation** (single choice): Excellent / Good / Acceptable / Poor
   "Please rate the quality of presentation (clarity of writing, figures,
   etc.) in the paper. Do not reject a paper because of anything that can be
   easily fixed/addressed in 15 minutes. Please justify your choice in your
   review."
4. **Technical Soundness** (single choice): Excellent / Good / Acceptable / Poor
   "Please rate the technical soundness of the work presented in the paper.
   Your review should not be about what should have been done; rather it
   should be a critique of what the authors actually did. Please justify your
   choice in your review."
5. **Reproducibility** (single choice): Yes / Maybe / No
   "Is the work presented reproducible by an experienced
   practitioner/researcher in the area? Please justify your choice in your
   review."
6. **References** (single choice): Yes / Some References Missing / No
   "Is prior work adequately cited? If not, please indicate missing key
   references in your review. Do not reject a paper because of a few missed
   citations. Please justify your answer in your review."
7. **IRB Approval Check** (single choice):
   - Not applicable (No experiment with human participants)
   - The experiments were approved.
   - The experiments were not approved; however, a reasonable explanation is provided.
   - The experiments were not approved, and no explanation is provided.
   Helper: "Research experiments with human participants must be approved by
   an ethical review board if required by the authors' institution. Were the
   experiments approved (see submission form in addition to paper)? If not,
   did the authors provide a reasonable explanation?"
8. **Participant Demographics** (single choice):
   - Not applicable (No experiment with human participants)
   - Participant demographics are clearly and adequately reported.
   - Participant demographics are minimally reported.
   - Participant demographics are not reported.
   Helper: "Does the submission clearly and adequately report participant
   demographics (gender, age, etc.)? Or, does the submission report enough
   information to replicate the recruiting procedures?"
9. **Participant Diversity** (single choice):
   - Not applicable (No experiment with human participants)
   - Participant population strives to represent the target population.
   - Participant population does not represent the target population.
   - Participant demographics are not reported.
   Helper (show the bullets): "To support high-quality research, all
   submissions describing research with human participants should strive for
   participant diversity.
   • Research that aims to benefit a general population should be
     representative of that population (e.g. balanced across gender or age).
   • Research that claims to benefit a specific population should clearly
     state and justify its focus on that population (e.g. pilots, surgeons).
   • Research collects from a non-standard population (e.g. recruited outside
     of a convenience sample in a lab environment).
   Does the submission strive for participant diversity?"
10. **Overall Rating** (single choice): 8 - Definite accept / 7 - Accept /
    6 - Probably accept / 5 - Possibly accept / 4 - Possibly reject /
    3 - Probably reject / 2 - Reject / 1 - Definite reject
    "Provide your overall rating of the paper. Whenever possible, provide a
    strong rating."
11. **Review** (long text)
    "Write here the helpful review that you would want to receive as an
    author.
    • A high quality review should have several paragraphs. Short (one
      paragraph or less) and/or unjustified reviews are insufficient and you
      may be asked to rewrite your review.
    • Describe the contributions of the paper and why they are noteworthy.
      Reflect on the potential contributions of the work.
    • Discuss weaknesses and limitations explicitly in a constructive manner.
      Do not be insulting - be constructive. Call out the strengths and
      utility of the work.
    • Avoid the fallacy of novelty. Specifically, do not simply reject papers
      because they replicated experiments. Consider how the author's
      arguments, results, and demonstrations fit into closely related work as
      well as the field as a whole.
    Please consider making any other recommendations that you think might be
    of use to the author(s), but please take into account the tight schedule
    for the final submissions."

Keep this form definition in one data structure (e.g. `FORM` in a separate
`form_schema.json`) so the next year's form can be swapped in without
touching the code.

## Core idea: a guided review, not a form

**This is the most important requirement.** Don't build a page that shows
the PCS fields and lets me fill them in. Build a step-by-step coach that
walks me through reviewing the paper the way an excellent reviewer would,
and builds each PCS answer from the evidence I've gathered by that point.
The PCS form only appears at the very end, already filled in from my own
work, for a final polish and copy.

Principles of the flow:
1. **One step at a time.** The main area shows one step. Inside a step, ask
   one question (or one small group of related questions) at a time, like an
   interview. Don't show the whole list at once.
2. **Evidence before judgment.** Each step first asks what I found in the
   paper, with a section, page, or figure reference where relevant. Only after
   that does it ask for the rating, and then it requires a written
   justification. The rating control stays locked until the evidence
   questions are answered (or explicitly marked "N/A" or "unsure" with a
   reason).
3. **The order follows how a good review is reasoned, not the PCS form
   order.** Understand the paper, then assess each dimension, then synthesize,
   then decide, then write. The PCS order is used only for the final sheet and
   the exports.
4. **Everything accumulates into a findings ledger.** While answering, I can
   promote any observation to the ledger as a **Strength**, **Major
   concern**, **Minor concern**, or **Question for authors**, tagged with the
   dimension it came from (soundness, clarity, …) and a location in the paper.
   Later steps reuse the ledger, so nothing I wrote earlier is lost or retyped.
5. **The tool composes, I write.** When a PCS text field is due (Summary of
   Contributions, Review), the tool assembles a draft only from my own
   answers, justifications, and ledger items, placed in the right structure.
   I then edit it. The tool never invents sentences, beyond fixed section
   labels and connective headings.
6. **Gating with freedom to go back.** "Next" is enabled when the step's
   required items are done. I can always go back. If I change an earlier
   answer that later steps depend on (e.g. a soundness concern after the
   rating was set), mark those later steps "needs re-check" in the progress
   rail.
7. **Coaching at the right moment.** Show principle reminders and
   consistency warnings inline, on the step where they matter (e.g. the "15
   minutes" rule while rating clarity, the novelty-fallacy reminder while
   writing a concern about novelty), not in a separate panel I have to
   remember to open.

Put the step definitions (step id, title, the PCS field(s) it feeds, the
questions with their type: text / yes-no-unsure / checklist / list / choice,
and which ones are required, plus guidance text) in `flow.json`, so I can
edit questions without touching code. Keep the PCS form itself in
`form_schema.json`.

## Reviewing principles (inline coaching content)

Adapted from the CHI Guide to Reviewing Papers and applied to IEEE VR. Show
these as context on the steps listed in brackets, and keep them all on an
"About reviewing" page reachable from the header.
- **Core question** [Step 1, Step 10]: does this submission make a strong,
  original contribution to VR/AR/MR and 3DUI? Judge it by its own
  contribution type and its own quality, not by how well it fits a topic or
  subcommittee you'd expect. Any topic is valid if it interests a reasonable
  share of the audience.
- **Length and effort** [Step 11]: a high-quality review is typically about a
  page of text. Very short reviews frustrate authors, are less constructive,
  and can't support decisions in the discussion.
- **Justify everything,** positive or negative [every rating]. The written
  appraisal must match the rating.
- **Put yourself in the authors' position** [Steps 8, 11].
- **Commensurate expectations** [Steps 3, 8, 11]: judge the contribution
  relative to the paper's length and scope. Don't ask for more than a focused
  contribution needs. Verbose or repetitive text, missing details, missing
  prior work, or formatting tricks to save space are legitimate concerns.
- **Transparency** [Steps 3, 4]: opaque reporting of methods or results is a
  valid reason to doubt a contribution.
- **Replication is a contribution** [Steps 1, 4, 8]. Constructive
  replications can be significant. Reward complete, well-organized
  supplementary material (software, analysis code, data).
- **Overlap and prior work** [Step 6]: don't count independently developed
  concurrent work, or work published after the 31 Aug 2026 submission
  deadline, against the paper. A revision of the authors' own non-archival
  work (posters, demos, tech reports) is allowed at IEEE VR; only the primary
  reviewer sees the non-anonymous letter explaining it.
- **Critique what was done** [Step 3]: critique what the authors actually
  did, not the paper you would have written.
- **Confidentiality and AI tools** [Step 0, final step]: don't quote, share,
  or discuss the paper outside the review process, and don't paste its
  content into online tools that may store or process it (LLMs included).
  You're responsible for the accuracy of everything in your review,
  including every reference you suggest.

## The guided steps

A progress rail on the left lists the steps below (not the PCS fields), each
with its state: not started / in progress / done / needs re-check / skipped
(N/A). Under each step, show small chips naming the PCS field(s) it feeds,
so I can see how the form is being built.

### Step 0: Set up and screen
- Paper ID, title, my reviewer role (primary/coordinator, secondary, external).
  Optional PDF path (shown side by side, served locally only).
- Confidentiality reminder (acknowledge once per paper).
- Desk-reject screening, asked one item at a time (yes / no / unsure plus a
  note):
  - Uses the IEEE VGTC conference template.
  - 4 to 9 pages of content, excluding references. References ≤ 2 pages.
    Appendices count toward the 9 pages.
  - Properly anonymized: no author names, institutions, funding sources, or
    workplaces; own prior work cited in the third person; supplementary video
    also anonymous. (An arXiv preprint is not by itself grounds for
    rejection. Don't search for it.)
  - Engages meaningfully with VR/AR/MR/3DUI literature. Pure CV or graphics
    papers with few or no such references may be out of scope.
  - Includes an evaluation of its contributions (user study, benchmark, or
    comparison with existing systems, techniques, or methods). Mandatory at
    IEEE VR.
  - Generative AI use, if any, is disclosed in the acknowledgments.
  - No signs of prior publication or concurrent submission.
  If any item is "no", show a notice that I should contact the coordinator or
  Paper Chairs. Let me continue anyway.

### Step 1: Understand the paper (no judging yet)
Ask in sequence:
- In one or two sentences, what problem does the paper address?
- What approach do the authors take?
- Contribution type(s), multi-select from the IEEE VR categories, each with
  what it must include:
  - **Methodological**: advances in theories and methods (ethics, presence
    theory, human factors).
  - **Technical**: advances in algorithms or devices (input, display,
    interaction, tracking).
  - **Application**: novel use of existing ideas to solve a problem; must
    evaluate how successful VR/AR/MR/3DUI is in that domain.
  - **System**: integration of techniques into an effective system; must
    report lessons learned.
  Show CHI contribution lenses as secondary hints (empirical, artifact,
  methodological, theoretical, dataset, survey, opinion, replication). Each
  type is judged on its own terms.
- List the claimed contributions as separate entries, one per contribution.
  Each entry gets: claim text, where it's stated, and the evidence offered
  (filled in now or in Step 3).
- Does the paper involve human participants? (Yes/No.) This drives whether
  Step 7 is applicable, and the IRB/Demographics/Diversity N/A options.
- A "Put yourself in the authors' position" prompt: what would the authors
  say is the single most important thing in this paper?
At the end of the step, show a recap: "Here's your understanding of the
paper."

### Step 2: Expertise → PCS: Expertise
- Short self-check: how familiar am I with the topic, the methods, and the
  closely related work? Then the choice. Reminder: "Passing Knowledge" is
  fine and helps the coordinator weigh reviews.

### Step 3: Technical soundness → PCS: Technical Soundness
Walk through the claims from Step 1 **one by one**: "Claim N: … Is it
supported by the evidence? (Fully / Partially / Not) What's missing?" Then
ask the method questions that apply, depending on the contribution type and
whether there are human participants:
- Study design: conditions, counterbalancing, sample size or power, task
  validity, confounds.
- Statistics: assumptions checked, test matches design, effect sizes,
  multiple-comparison correction, no over-interpretation of non-significant
  results.
- Measures: validated questionnaires (SSQ, IPQ, NASA-TLX, SUS, …) used and
  scored properly.
- Technical work: baselines, metrics, ablations, hardware and latency
  reported.
- Limitations acknowledged honestly?
Each "no" or "partially" offers "Add to ledger as concern" with the
location pre-filled. Then the rating (Excellent / Good / Acceptable / Poor),
with a rubric showing what each level means and a recap of my
claim-support answers. Then a required "justification for the review"
(2–4 sentences).

### Step 4: Reproducibility → PCS: Reproducibility
Checklist, one item at a time: hardware (HMD model, tracking, refresh
rate) and software versions; apparatus and environment; study protocol and
instructions; analysis procedure; code, data, or materials shared
(anonymously) or promised; enough detail in the main paper on its own (CHI's
stand-alone principle). Then the choice (Yes / Maybe / No) and a required
justification.

### Step 5: Clarity of presentation → PCS: Clarity of Presentation
Checklist: abstract matches findings; research questions or hypotheses
stated; figures readable and captioned; terminology consistent; structure
lets you find method and results quickly; length proportional to
contribution. A separate "minor fixes" list (typos, labels) that defaults to
Minor concern. Inline reminder at the rating: issues fixable in 15 minutes
don't drive the rating. Then the choice and a required justification.

### Step 6: References and positioning → PCS: References
- Is the work positioned against the closest related work? Does the
  novelty claim hold?
- A structured list of missing key references, each with: citation, year or
  venue, why it matters, and a "verified it exists" checkbox. Warn if the
  year is after 2026-08-31.
- Choice (Yes / Some References Missing / No) and a required justification.
  Selecting "Some missing" or "No" with an empty list blocks "Next".

### Step 7: Ethics and participants → PCS: IRB Approval Check, Participant Demographics, Participant Diversity
Skipped automatically, with all three set to "Not applicable", if Step 1
said there are no human participants. Otherwise, three sub-steps:
- **IRB:** what does the paper say? What does the PCS submission form say?
  (Reminders: an exemption counts as approval; "not required by institution
  or country" must be stated in the paper and in PCS.) Then the choice.
- **Demographics:** a checklist of what's reported (N; age mean/SD/range;
  gender; prior VR/AR experience; vision/stereo acuity where relevant;
  handedness where relevant; recruitment; compensation; exclusions or
  dropouts, e.g. cybersickness). Suggest the matching option based on
  what's ticked, and I confirm it.
- **Diversity:** who is the claimed target population? Does the sample match
  it? Is a specific-population focus stated and justified? If the claims are
  general but the sample is severely imbalanced, IEEE VR strongly encourages
  treating this as a primary concern: offer to add it to the ledger as a
  Major concern. Then the choice.

### Step 8: Synthesize the findings ledger
Show the full ledger grouped by type. Ask me to:
- Rank the strengths and keep the top ones. Prompt: "Have you named at least
  as many genuine strengths as concerns you'd want to hear about yourself?"
- Review each Major concern with a small coaching form: **what** the issue
  is, **where** it is, **why it matters** to the claims, **what would
  resolve it**, and whether that's **feasible in the ~1-month revision
  window**. A concern can't be marked "ready" until these are filled.
- Demote or promote concerns between major and minor, merge duplicates, and
  drop concerns about what I'd have done differently rather than what the
  authors did.
- Check novelty: if any concern is "not novel" or "already done", show the
  replication and concurrent-work reminders and ask me to confirm it still
  holds.

### Step 9: Summary of Contributions → PCS: Summary of Contributions
The tool assembles a draft from my Step 1 answers (problem, approach,
contributions) plus the top strengths and major concerns from the ledger,
in this shape: a neutral summary paragraph, then "Strengths:" bullets, then
"Weaknesses:" bullets. I edit it. Check: would the authors recognize their
paper in this summary?

### Step 10: Overall rating → PCS: Overall Rating
Before showing the scale, show a decision dashboard: the four dimension
ratings, ledger counts (strengths, major, minor), the main criterion
("degree to which the paper contributes substantial new research or
scholarship to VR/AR/MR and 3DUI"), and the IEEE VR outcomes (TVCG /
conference paper / reject; conditional acceptance with a revision checked by
the coordinator; a discussion period to reach consensus). Then:
- "If the authors addressed every major concern in the revision, would this
  be a solid IEEE VR paper?" (Yes / Probably / No)
- The 1–8 choice. Prompt to commit: "Whenever possible, provide a strong
  rating". If I pick 4 or 5, ask what would move it up or down.
- A required "justification of rating" paragraph, written by me.
Inline mismatch warnings: 1–3 with no major concerns; 7–8 with several
unresolved major concerns; 6–8 with only one or two strengths written up.

### Step 11: Write the Review → PCS: Review
Build the review **section by section**, one section per sub-step. Each
section opens prefilled with the relevant material I already wrote, as
editable text, plus a short prompt about what makes that section good:
1. Summary and contribution, and why it matters (from Steps 1 and 9).
2. Strengths (from the ledger).
3. Major concerns, numbered, each from its what/where/why/fix form.
4. Minor concerns and minor fixes.
5. Clarity, soundness, reproducibility, references, and ethics/participants,
   each from that step's justification, so every rating is justified in the
   text as the form requires.
6. Requested changes for the revision: prioritized, concrete, feasible
   within the revision window.
7. Justification of the overall rating (from Step 10).
Then a full preview of the assembled review with a live word count and a
progress indicator toward about one page (~500–700 words, not a hard limit;
warn below ~400 words or 3 paragraphs). Inline flags on the text:
- Tone words ("trivial", "obviously", "useless", "sloppy", …), with a
  reminder to be constructive. I rewrite them; the tool doesn't.
- Possible identity leaks ("my paper", "our lab", "I previously published").
- Scope-creep requests ("run a new study", "another experiment"), with the
  commensurate-expectations reminder.
- A rated dimension never mentioned in the text.

### Step 12: Final check and the PCS sheet
Run all consistency checks (listed below) as a checklist I tick or
explicitly dismiss. Then, and only then, show the **PCS sheet**: all 11
fields in exact PCS order, with exact headings and option labels, my final
values, and a "Copy" button per field plus "Copy all". Fields remain editable
here for final polish, and edits sync back to the step they came from.

## Consistency checks (computed live, shown on the relevant step and gathered in Step 12)
- Any PCS field unset or empty.
- Review too short (see Step 11).
- High rating (6–8) with a short or strengths-only review.
- A suggested reference not marked "verified it exists", or dated after
  2026-08-31.
- References "Some References Missing" or "No" with no references listed.
- A rated dimension not mentioned in the Review.
- Human-participant fields inconsistent with Step 1 (e.g. IRB "Not
  applicable" but the paper has participants).
- Overall rating inconsistent with the ledger (see Step 10).
- A Major concern missing its what/where/why/fix.
- Identity leaks, tone words, scope-creep requests, and the novelty-fallacy
  pattern ("not novel" or "already done" plus a low rating).

## Persistence details for the guided flow
- `review.json` stores, for every step, every question **with its question
  text and the PCS heading(s) it feeds**, my answer, and a timestamp. It
  also stores the ledger (each item with type, dimension, location,
  what/why/fix fields, and linked PCS heading) and the final PCS values (with
  exact headings). It records the current step, so reopening resumes exactly
  where I was.
- `review.md` begins with the **PCS section**: the 11 `## <PCS heading>`
  blocks in form order, with values (fields not reached yet say
  "_not yet completed_"). Below that is a clearly marked appendix, "Working
  notes: do NOT paste into PCS", grouped by PCS heading, listing each step
  question and my answer, followed by the ledger.

## UX requirements
- Layout: the progress rail on the left (steps + state + PCS-field chips),
  the current step in the center, and the optional PDF on the right. A small
  "PCS progress" meter in the header shows how many of the 11 fields are
  filled, without showing the fields themselves.
- Big, calm, readable question cards. A clear "Back" / "Next" footer.
  "Next" shows why it's disabled when it is.
- Live word count on long-text answers, which auto-grow.
- Visible save status ("Saved 12:03:41" / "Saving…" / "Error: not saved").
- Keyboard: Ctrl/Cmd+S saves; Ctrl/Cmd+Enter = Next; Alt+←/→ goes to the
  previous or next step.
- Light and dark themes following `prefers-color-scheme`. Plain typography.
  No frameworks.
- Multiple papers: a start screen lists the existing `reviews/*/` folders with
  their current step, and lets me create a new one.
- Export menu (available any time): download `review.md`, copy the PCS sheet.

## Deliverables

- `review_helper.py` (server and file I/O), `static/index.html` (UI, inline
  or alongside `app.js`/`style.css`), `form_schema.json` (the PCS form),
  `flow.json` (the guided steps, questions, gating rules, and coaching text).
- A tool README with usage and the confidentiality statement, and a note
  that IEEE VR / CHI reviews must not be pasted into external AI services.
- A small test script (`python3 -m unittest`) covering: save then load
  round-trip, including resuming at the saved step; atomic write; backup
  rotation; markdown export order matching the PCS form; the gating rules
  (rating locked until evidence answered, Step 7 auto-skip when there are no
  human participants, "References missing" with an empty list blocks Next);
  the "needs re-check" propagation; draft composition, which uses only my own
  text; and the consistency-check logic. Implement the flow and check logic
  so it's testable: mirror it in Python, or test the JS with a tiny harness
  that runs without npm, whichever is simpler.

## Process

1. Read this whole spec, then propose the file layout, the `flow.json` shape,
   and the `review.json` schema in a few lines before writing code.
2. Implement, then run the tests. Start the server once and walk a dummy
   paper through all steps (scripted via the API is fine). Confirm that the
   PCS sheet only fills in as the steps complete, and that `review.json` and
   `review.md` contain the PCS headings exactly as in the form, in order,
   plus the step answers linked to their headings.
3. Report what you built, how to run it, and anything you deliberately left
   out.
````

---

## Notes for you

- The form fields and helper texts come from the screenshots of the PCS form,
  copied word for word, so the export lines up with PCS.
- The IEEE VR rules in the guidance (contribution categories, mandatory
  evaluation, 4–9 pages, anonymization, ethics options, diversity stance,
  TVCG/conference outcomes, GenAI disclosure) come from the 2027 CFP page.
- The CHI 2027 additions are: length proportional to contribution, the
  stand-alone main paper (don't rely on supplements), reproducibility
  materials, situating in related work, inclusivity, and the contribution-type
  lenses.
- The CHI Guide to Reviewing Papers (2025 edition) adds the inline
  "Reviewing principles" coaching and several checks. These cover: review length of about a
  page; justifying positive ratings as well as negative ones; making the
  written review match the rating; keeping expectations in line with length
  and scope; transparency; valuing replications; not counting concurrent or
  later work against the authors; judging the paper on its own quality rather
  than topic fit; and confidentiality, including no LLM tools and checking
  that every suggested reference exists. The CHI contribution-type list (empirical,
  artifact, …) still comes from general CHI practice, because the guide only
  links to it.
- The flow is ordered the way a review is reasoned (understand → assess →
  synthesize → rate → write), not in PCS order. The PCS sheet only appears,
  already filled in, at the end. Questions and coaching live in `flow.json`, so
  you can tune them later without code changes.
- The detailed IEEE VR review-instructions Google Doc linked in the reviewer
  email wasn't accessible. If you have it, add its key points to `flow.json`
  after the tool is built.
