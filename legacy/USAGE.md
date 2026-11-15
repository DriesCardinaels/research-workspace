# Review Helper: usage

A guided, step-by-step coach for writing an IEEE VR 2027 paper review. It
interviews you from understanding the paper, through assessing each criterion,
to synthesis, rating and writing. It builds the PCS review form from your own
answers as you go. The form only appears at the end, already filled in, ready
to copy into PCS.

(`README.md` contains the build prompt this tool was made from.)

## Confidentiality

Submissions under review are confidential. This tool runs **fully offline**:
it binds to `127.0.0.1` only, loads nothing from the internet (no CDNs, no
analytics, no telemetry) and makes no LLM or API calls. Nothing about the paper
or your review leaves this machine.

Don't paste the paper or your review into external AI services. IEEE VR and
CHI reviewing guidance asks reviewers not to share unpublished submissions with
online tools that may store or process them.

## Run

Requires Python 3.8+; there's nothing to install.

```bash
python3 review_helper.py
```

Optionally pass the paper PDF to show it side by side:

```bash
python3 review_helper.py ~/Downloads/paper1234.pdf
```

Options: `--port 8765`, `--reviews <dir>` (default `./reviews`),
`--no-browser`.

## The flow

| Step | What happens | Builds PCS field(s) |
|---|---|---|
| 0 | Paper details, confidentiality, desk-reject screening | (none) |
| 1 | Understand the paper: problem, approach, contribution type, each claim, participants | Summary, Review |
| 2 | Expertise self-check | Expertise |
| 3 | Each claim against its evidence; design, statistics, measures | Technical Soundness |
| 4 | Reproducibility checklist | Reproducibility |
| 5 | Clarity checklist and minor fixes | Clarity of Presentation |
| 6 | Positioning, novelty, missing references | References |
| 7 | IRB, demographics, diversity (skipped if no participants) | IRB, Demographics, Diversity |
| 8 | Synthesize: rank strengths; make each major concern actionable | Summary, Review |
| 9 | Summary assembled from your notes; you edit | Summary of Contributions |
| 10 | Decision dashboard, then the rating and its justification | Overall Rating |
| 11 | Review written section by section, each prefilled from your notes | Review |
| 12 | Consistency checks, then the PCS sheet with Copy buttons | (none) |

How the flow works:
- **Evidence before judgment.** A rating stays locked until that step's
  evidence questions are answered, or marked N/A or unsure with a reason.
- **Findings ledger.** Any observation can be saved as a strength, a major or
  minor concern, or a question for the authors. Steps 8–11 reuse it.
- **You write, the tool assembles.** Drafts contain only your own text plus
  fixed section labels.
- **Re-check.** If you change an answer that a finished step depends on, that
  step is marked "needs re-check" in the left rail.

Keyboard shortcuts: `Ctrl/⌘+Enter` goes to the next question, `Alt+←/→` moves
between steps, `Ctrl/⌘+S` saves, and `Esc` closes panels.

## Annotating the PDF

Click **PDF** in the top bar to open the paper next to the questions, and
**Wide PDF** to give it more room. Click **Focus PDF** to collapse the header,
review questions, step navigation, footer and annotation list, leaving the PDF
and its toolbar across the window. Click **Exit focus** or press **Esc** to
restore the previous layout. If a PDF comment or selection menu is open,
**Esc** dismisses that first. Your answers, annotations, zoom and reading
position are retained; review navigation shortcuts are paused while focusing.
The toolbar has four tools:

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Select text, then pick a color from the small menu that appears. Click a highlight to open it. |
| Highlight | `H` | Every text selection becomes a highlight in the current color. |
| Pen | `P` | Free-form drawing. Choose a color (red, blue, green, black) and width. |
| Eraser | `E` | Click or drag over a pen mark or highlight to remove it. |

Undo is `⌘/Ctrl+Z`. Zoom with `+`, `−` and `0` (fit width). The shortcuts
work while the pointer is over the PDF.

Highlight colors carry a meaning, set in `flow.json` under `annotation`:
- **Yellow:** Important
- **Green:** Strength
- **Pink:** Concern
- **Orange:** Minor issue
- **Blue:** Question

Click a highlight to:
- comment on it: add as many comments as you like (`⌘/Ctrl+Enter` posts),
  and edit or delete them later. A colored bubble on the page marks
  highlights that have comments;
- change its color;
- copy the quote;
- delete it;
- send it to the findings ledger with one click. The ledger type follows the
  color (pink becomes a major concern, green a strength, and so on), and the
  location is filled in as `p. N`.

**Notes** lists every highlight by page; click one to jump to it.

To paste your highlights into the review, there are three ways to copy them
with their comments:
- **Copy all** in the toolbar copies every highlight in reading order (page,
  then column, then top to bottom).
- **Copy** next to a color in the Notes panel copies only that color, for
  example all Concerns.
- **Copy with comments** in a highlight's popup copies just that one.

Each copied entry looks like this:

```text
p. 3 · Concern
“the quoted text”
  – your first comment
  – your second comment
```

**Export PDF** writes `reviews/<paper-id>/annotated.pdf`. Highlights and pen
marks are drawn into the pages, and each highlight's comments become a
sticky-note comment that Preview and Acrobat can show. The original PDF is never modified.

## Files

Everything is autosaved (debounced) to `reviews/<paper-id>/`:
- `review.json` is the source of truth. It holds the PCS fields with their
  exact headings, every answer with its question text and the PCS heading(s)
  it feeds, the ledger, and your current position, so reopening resumes where
  you left off.
- `review.md` is regenerated on every save. It starts with the PCS fields in
  form order, followed by an appendix of working notes (do NOT paste that
  part into PCS).
- `annotations.json` holds your highlights (page, position, color, quoted
  text, comments) and pen strokes, stored independently of zoom level.
  `review.md` lists the highlights under "PDF annotations".
- `annotated.pdf` is written when you click Export PDF.
- `backups/` holds the last 10 timestamped copies of `review.json`, at most
  one per minute, plus one on every manual save.

Writes are atomic (temp file plus rename).

## Customize

- `form_schema.json` is the PCS form (headings, options, helper text). Swap it
  for next year's form.
- `flow.json` holds the steps, questions, coaching text, rubrics and the
  word lists used by the checks.

## Tests

```bash
python3 -m unittest discover -s tests
```

These cover save/load and resume, atomic writes, backup rotation, the
order of the markdown export, gating (locked ratings, Step 7 skip, missing
references), re-check propagation, that drafts contain only your text, and
the consistency checks.

## Third-party code

Both libraries are vendored in `static/vendor/` and served locally, so
nothing is loaded from the internet:
- [PDF.js](https://mozilla.github.io/pdf.js/) 6.1.200 (Apache-2.0), for
  rendering and text selection.
- [pdf-lib](https://pdf-lib.js.org/) 1.17.1 (MIT), for exporting the
  annotated PDF.

Their licenses are next to the files.
