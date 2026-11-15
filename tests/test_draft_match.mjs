// Draft mark placement: LaTeX words vs PDF text items. Run: node tests/test_draft_match.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { latexWords, latexWordPositions, sourceRange, selectionWords, pageWords, findSpan, pickOccurrence, floats, floatOutsideCaption } = require('../static/draft.js');

const words = (ws) => ws.map((w) => w.w);

// LaTeX: citations, refs, math, comments and commands are dropped; command arguments stay.
assert.deepEqual(latexWords("Horn's method~\\cite{horn1981} computes the \\emph{slope} at $x_i$ % note\n"),
  ['horn', 's', 'method', 'computes', 'the', 'slope', 'at']);
assert.deepEqual(latexWords('see Section~\\ref{sec:x} and 50\\% of 12 cells'), ['see', 'section', 'and', 'of', 'cells']);

// PDF: line-end hyphens join, ligatures normalize, citation numbers are not anchors.
const items = [
  { str: 'Horn’s method [12] computes the slope while its pro-' },
  { str: 'cessing ﬁnally qualiﬁes it. Next sentence.' },
];
const pw = pageWords(items);
assert.deepEqual(words(pw), ['horn', 's', 'method', 'computes', 'the', 'slope', 'while', 'its', 'processing', 'finally', 'qualifies', 'it', 'next', 'sentence']);
assert.equal(pw[8].parts.length, 2, 'hyphenated word keeps both parts for its rectangles');

// A replacement is found by its words, with context choosing between repeats.
let span = findSpan(pw, latexWords('qualifies it'), latexWords('processing finally'));
assert.deepEqual(span, { from: 10, to: 11 });
const repeat = pageWords([{ str: 'it is here. Later the slope while it is here again.' }]);
span = findSpan(repeat, ['it', 'is', 'here'], ['slope', 'while']);
assert.equal(span.from, 7, 'context picks the second occurrence');

// Long passages: the tail is searched with slack for dropped citations.
const long = pageWords([{ str: 'a b c d e f g h i j k [3] l m n o p' }]);
span = findSpan(long, latexWords('c d e f g h i j k \\cite{x} l m n'), ['a', 'b']);
assert.deepEqual(span, { from: 2, to: 13 });

// A removal places a caret after its context; unknown text gives null.
assert.deepEqual(findSpan(pw, [], latexWords('computes the slope')), { at: 5 });
assert.equal(findSpan(pw, ['nowhere', 'to', 'be', 'found'], []), null);

// Double-click: pick the occurrence of the clicked word whose neighbors match the clicked PDF line.
const line = 'The slope uses eight heights. Later, a route crosses many heights near the crater rim.';
assert.equal(pickOccurrence(line, 'heights', latexWords('a route crosses many heights near the')), line.lastIndexOf('heights'));
assert.equal(pickOccurrence(line, 'heights', latexWords('The slope uses eight heights.')), line.indexOf('heights'));
assert.equal(pickOccurrence(line, 'height', []), -1, 'whole words only');

// PDF selection -> source range: offsets survive citations and commands; context picks the occurrence.
const src = 'Intro line.\n\nHorn\'s method~\\cite{horn1981} computes the \\emph{slope} at each cell. Later the slope at each cell differs.\n';
const pos = latexWordPositions(src);
assert.equal(src.slice(pos[2].start, pos[2].end), 'Horn');
let r = sourceRange(src, src.indexOf('Horn'), ['computes', 'the', 'slope'], []);
assert.equal(src.slice(r.start, r.end), 'computes the \\emph{slope}');
r = sourceRange(src, 0, ['slope', 'at', 'each', 'cell'], ['later', 'the']);
assert.equal(r.start, src.lastIndexOf('slope at'));
assert.equal(sourceRange(src, 0, ['not', 'there'], []), null);
// Partial words at both ends of a selection, and a line-end hyphen inside it.
r = sourceRange(src, 0, ['od', 'computes', 'the', 'slo'], []);
assert.equal(src.slice(r.start, r.end), 'method~\\cite{horn1981} computes the \\emph{slope}');
assert.deepEqual(selectionWords('com-\nputes the slope'), ['computes', 'the', 'slope']);
assert.deepEqual(selectionWords('data pro- cessing pipeline'), ['data', 'processing', 'pipeline']);
// One word: whole words win over parts of words.
const s2 = 'Another other word: the end.';
r = sourceRange(s2, 0, ['the'], []);
assert.equal(s2.slice(r.start, r.end), 'the');
// Escaped dollars are not math.
assert.deepEqual(latexWords('costs \\$5 and \\$6 total'), ['costs', 'and', 'total']);

// Floats: a change to the image or \Description is shown on the caption; a change in the caption text is not.
const fig = '% figure: \\begin{figure} in a comment\nText before.\n\\begin{figure*}[t]\n\\includegraphics{a.pdf}\n\\caption[Short]{\\textbf{Bold {nested} start.} Rest.}\n\\Description{Alt text.}\n\\end{figure*}\nAfter.\n';
const [f] = floats(fig);
assert.equal(floats(fig).length, 1);
assert.equal(f.caption.text, '\\textbf{Bold {nested} start.} Rest.');
const at = (s) => fig.indexOf(s);
assert.ok(floatOutsideCaption(fig, at('\\includegraphics'), at('\\includegraphics') + 10));
assert.ok(floatOutsideCaption(fig, at('Alt'), at('Alt') + 3));
assert.ok(floatOutsideCaption(fig, 0, fig.length));
assert.equal(floatOutsideCaption(fig, at('Rest'), at('Rest') + 4), null);
assert.equal(floatOutsideCaption(fig, at('Text before'), at('Text before') + 4), null);
assert.equal(floatOutsideCaption(fig, at('After'), at('After') + 5), null);
assert.equal(floats('\\begin{table}\\caption{T}').length, 0); // unclosed: ignored

console.log('PASS: PDF selection to source range; double-click word choice; LaTeX words, PDF words (hyphens, ligatures, citations), span search with context, removals; floats and captions');
