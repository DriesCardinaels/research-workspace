// Writing analysis: sentences from LaTeX, rule marks, readability. Run: node tests/test_writing.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const W = require('../static/writing.js');

const texts = (src) => W.sentences(src).map((s) => s.text);

// Sentences: abbreviations, citations, math and headings.
assert.deepEqual(texts('Buneman et al.~\\cite{b} separate two kinds. They differ, e.g. in scope. See Fig. 3 for more.'),
  ['Buneman et al. separate two kinds.', 'They differ, e.g. in scope.', 'See Fig. 3 for more.']);
assert.deepEqual(texts('\\paragraph{Composing spatial models.} Models compose well here. The slope $s_i$ is steep.'),
  ['Models compose well here.', 'The slope X is steep.']);
assert.deepEqual(texts('One sentence here % a comment. Not a sentence\nstill one.\n\nNew paragraph starts now'),
  ['One sentence here still one.', 'New paragraph starts now']);
assert.deepEqual(texts('\\begin{figure}Caption words here. More words.\\end{figure}Real text is here.'), ['Real text is here.']);
assert.deepEqual(texts('\\documentclass{x}\\title{T}\\begin{document}Body text is here.\\end{document}'), ['Body text is here.']);
// ACM metadata is not prose: \ccsdesc, \keywords, the author block and CCSXML vanish with their arguments.
assert.deepEqual(texts([
  '\\begin{document}',
  '\\author{Ann Lee}\\affiliation{\\institution{UHasselt}\\city{Diepenbeek}\\country{Belgium}}',
  '\\begin{CCSXML}<ccs2012><concept_desc>Human-centered computing</concept_desc></ccs2012>\\end{CCSXML}',
  '\\ccsdesc[500]{Human-centered computing~Interactive systems and tools}',
  '\\ccsdesc[300]{Information systems~Data provenance}',
  '\\keywords{telerobotics, supervisory control, digital elevation models, terrain maps, data provenance}',
  '\\maketitle',
  '\\fancyhead[LE,RO]{\\footnotesize EICS 2027 draft}\\setlength{\\parskip}{4pt plus 1pt}',
  'Body text is here. A second one follows.',
  '\\end{document}'].join('\n')), ['Body text is here.', 'A second one follows.']);

// Offsets point into the source, so marks land on the source text.
{
  const src = 'Intro words here. The map was computed by Horn et al.~\\cite[p.~7]{horn} for each cell.';
  const { marks } = W.analyze(src);
  for (const m of marks) assert.equal(src.slice(m.start, m.end), m.text);
  assert.deepEqual(marks.map((m) => [m.rule, m.text]), [['passive', 'was computed'], ['citepage', '\\cite[p.~7]{horn}']]);
}

// Rules.
{
  const src = 'This shows that the slope is very steep, and the map, in turn, is utilized by the rover (a small one). We model the colour of terrain in order to plan.';
  const got = W.analyze(src).marks.map((m) => [m.rule, m.text.slice(0, 20)]);
  assert.deepEqual(got, [
    ['bare-this', 'This'], ['commas', 'This shows that the s'.slice(0, 20)], ['intensifier', 'very'], ['passive', 'is utilized'],
    ['plain', 'utilized'], ['parens', '(a small one)'], ['british', 'colour'], ['plain', 'in order to'],
  ]);
  const long = 'word '.repeat(26).trim() + '.';
  assert.deepEqual(W.analyze(long).marks.map((m) => [m.rule, m.hint]), [['long', '26 words']]);
  assert.equal(W.analyze('word '.repeat(25).trim() + '.').marks.length, 0);
  // "based on", "related to": adjectives, not passive.
  assert.equal(W.analyze('The method is based on slopes. It is related to maps.').marks.filter((m) => m.rule === 'passive').length, 0);
  // Every rule has a label and a reason; only two are on by default.
  assert.ok(W.RULES.every((r) => r.label && r.why));
  assert.deepEqual(W.RULES.filter((r) => r.on).map((r) => r.id), ['long', 'commas']);
  // Thin spaces (\,) and braced number commas (1{,}000) are not commas; real ones still count.
  const commas = (s) => W.analyze(s).marks.filter((m) => m.rule === 'commas').map((m) => m.hint);
  assert.deepEqual(commas('Its height is \\ExH\\,m, its RMS is $3$\\,m and its count is 1{,}000.'), []);
  assert.deepEqual(commas('Grids with 2\\,m spacing, a seed, and a shift.'), ['2 commas']);
  assert.equal(W.countWords(W.wordMask('About 1{,}000 heights.')), 3);
  // siunitx reads as the PDF does: a number, plus a word for a unit other than % or °.
  const si = 'Its height is \\qty{\\ExHeight}{\\meter}, its RMS is \\qtyrange[x]{0.27}{0.41}{\\meter} and \\qty{92.5}{\\percent} of \\num{65536} slopes exceed \\qty{15}{\\degree}.';
  const plain = 'Its height is 1918.2 m, its RMS is 0.27 m and 92.5\\% of 65,536 slopes exceed 15°.';
  assert.equal(W.countWords(W.wordMask(si)), W.countWords(W.wordMask(plain)));
  assert.deepEqual(commas(si), []);
  assert.equal(W.proseMask('$\\qty{2}{\\meter}$ wide.').trim()[0], 'X'); // inside math: math placeholder
}

// Syllables (dictionary counts).
const syl = { layer: 2, any: 2, pipeline: 2, computed: 3, added: 2, changes: 2, examples: 3, "supplier's": 3, quality: 3,
  the: 1, walked: 1, therefore: 2, gradient: 3, suspicious: 3, nation: 2, social: 2, area: 2 /* known undercount: 3 */ };
for (const [w, n] of Object.entries(syl)) assert.equal(W.syllables(w), n, w);

// Scores: Flesch Reading Ease and Flesch-Kincaid grade from words, sentences and syllables.
{
  const s = W.analyze('The cat sat. The dog ran far.').scores; // 7 words, 2 sentences, 7 syllables
  assert.equal(s.words, 7); assert.equal(s.sentences, 2);
  assert.ok(Math.abs(s.fre - (206.835 - 1.015 * 3.5 - 84.6 * 1)) < 1e-9);
  assert.ok(Math.abs(s.fkGrade - (0.39 * 3.5 + 11.8 * 1 - 15.59)) < 1e-9);
  assert.equal(W.analyze('% only a comment').scores, null);
}

// "Ignore here" keys: same words → same key, any edit → new key.
assert.equal(W.fingerprint('long', 'A  b c.'), W.fingerprint('long', 'a b c.'));
assert.notEqual(W.fingerprint('long', 'a b c.'), W.fingerprint('long', 'a b d.'));
assert.notEqual(W.fingerprint('long', 'a b c.'), W.fingerprint('commas', 'a b c.'));

console.log('PASS: sentences from LaTeX, source offsets, rules, syllables, scores, ignore keys');

// Word count: written words only, for the file and for a selection.
{
  const wc = (src) => W.countWords(W.wordMask(src));
  assert.equal(wc('Plain words here.'), 3);
  assert.equal(wc('Slope $s_i = 3$ is steep~\\cite{horn}, see Fig.~\\ref{f}.'), 5); // Slope is steep see Fig
  assert.equal(wc('\\section{Related Work}\\label{s} The \\emph{rover} moves.'), 3); // headings do not count
  assert.equal(wc('Text\\footnote{A short note.} ends % not counted\nhere.'), 6);
  assert.equal(wc('\\begin{figure}\\includegraphics[width=3cm]{a.png}\\caption{Two maps \\cite{x}.}\\label{f}\\end{figure}'), 0); // captions do not count (for now)
  assert.equal(wc('\\begin{teaserfigure}\\includegraphics[width=\\textwidth]{t.pdf}\\caption{Three steps.}\\Description{Alt text not printed.}\\end{teaserfigure}'), 0);
  assert.equal(wc('\\keywords{maps, provenance}\\ccsdesc[500]{Human-centered computing} human--robot teams 3.5 times'), 5);
  // A selection counts the words it touches; a word cut in half counts once.
  const src = 'Alpha \\textbf{beta} gamma delta.';
  const mask = W.wordMask(src);
  assert.equal(mask.length, src.length);
  assert.equal(W.countWords(mask, src.indexOf('beta'), src.indexOf('delta')), 2);
  assert.equal(W.countWords(mask, src.indexOf('lpha'), src.indexOf('lpha') + 2), 1);
  assert.equal(W.countWords(mask, 6, 14), 0); // only "\textbf{"
}
console.log('PASS: word count');
