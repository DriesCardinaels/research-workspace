import {withToolRuntime} from './support/tool-runtime.mjs';
// Source formatting commands in the workspace. Run: node tests/test_format.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = { DraftMatch: {} };
vm.runInNewContext(withToolRuntime(readFileSync(new URL('../static/workspace.js', import.meta.url), 'utf8')), { window });
const { formatEdit, commentEdit } = window.Workspace;

// "[" and "]" mark the selection before and after the command.
function apply(marked, fn) {
  const s = marked.indexOf('['), e = marked.indexOf(']') - 1;
  const text = marked.replace('[', '').replace(']', '');
  const r = fn(text, s, e);
  const out = text.slice(0, r.from) + r.insert + text.slice(r.to);
  return out.slice(0, r.selFrom) + '[' + out.slice(r.selFrom, r.selTo) + ']' + out.slice(r.selTo);
}
const wrap = (kind) => (t, s, e) => formatEdit(t, s, e, kind);
const cases = [
  // Style: wrap, unwrap from inside or around, empty selection, spaces stay outside.
  ['a [word] b', 'bold', 'a \\textbf{[word]} b'],
  ['a \\textbf{[word]} b', 'bold', 'a [word] b'],
  ['a [\\textbf{word}] b', 'bold', 'a [word] b'],
  ['a [] b', 'emph', 'a \\emph{[]} b'],
  ['a [two words ]b', 'emph', 'a \\emph{[two words]} b'],
  ['a \\emph{[x]} b', 'emph', 'a [x] b'],
  ['run [make] now', 'code', 'run \\texttt{[make]} now'],
  ['the [Hallmark] tool', 'quote', "the ``[Hallmark]'' tool"],
  ["the ``[Hallmark]'' tool", 'quote', 'the [Hallmark] tool'],
  // Citations and references: ~ replaces the space before; unwrapping gives the space back.
  ['shown by [smith2020]', 'cite', 'shown by~\\cite{[smith2020]}'],
  ['shown by [smith2020 ]x', 'cite', 'shown by~\\cite{[smith2020]} x'],
  ['shown by~\\cite{[smith2020]}', 'cite', 'shown by [smith2020]'],
  ['shown by [~\\cite{smith2020}].', 'cite', 'shown by [smith2020].'],
  ['[key]', 'cite', '\\cite{[key]}'],
  ['line\n[key]', 'cite', 'line\n\\cite{[key]}'],
  ['x~[key]', 'cite', 'x~\\cite{[key]}'],
  ['see [a, b]', 'cite', 'see~\\cite{[a, b]}'],
  ['Section [sec:method]', 'ref', 'Section~\\ref{[sec:method]}'],
  // Footnote: attached to the previous word.
  ['a claim [see the appendix].', 'footnote', 'a claim\\footnote{[see the appendix]}.'],
  ['a claim\\footnote{[see the appendix]}.', 'footnote', 'a claim [see the appendix].'],
];
for (const [input, kind, want] of cases) assert.equal(apply(input, wrap(kind)), want, `${kind}: ${JSON.stringify(input)}`);

// % comment toggle: whole lines, blank lines untouched, indentation kept.
const comments = [
  ['one [two] three\nnext', '[% one two three]\nnext'],
  ['[a\n\n  b]\nc', '[% a\n\n  % b]\nc'],
  ['[% a\n  % b]', '[a\n  b]'],
  ['[%a\nb]', '[% %a\n% b]'],
  ['a\n[b\n]c', 'a\n[% b]\nc'],
  ['x[]', '[% x]'],
];
for (const [input, want] of comments) assert.equal(apply(input, commentEdit), want, `comment: ${JSON.stringify(input)}`);
console.log(`ok ${cases.length} wrap cases, ${comments.length} comment cases`);

// Citations: keys in \cite variants, comments ignored, completion context and ranking.
const plain = (f) => (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null'); // values from the VM context
const citeUses = plain(window.Workspace.citeUses), citeContext = plain(window.Workspace.citeContext), citeMatches = plain(window.Workspace.citeMatches);
assert.deepEqual(citeUses('See~\\citep[p.~3]{a,  b} % \\cite{x}\n\\cite{} \\nocite{*} 50\\% \\citet{c}').map((u) => u.key), ['a', 'b', '', 'c']);
const t = 'x \\cite{ab, cd}';
const u = citeUses(t);
assert.deepEqual(u.map((x) => t.slice(x.start, x.end)), ['ab', 'cd']);
assert.deepEqual(citeContext('see~\\cite{smi', 13), { from: 10, to: 13, query: 'smi' });
assert.deepEqual(citeContext('see~\\cite{a, smi}', 15), { from: 13, to: 16, query: 'sm' });
assert.equal(citeContext('see~\\cite{a} smi', 16), null);
assert.equal(citeContext('% see~\\cite{smi', 15), null);
const entries = [{ key: 'barker2021', author: 'Barker et al.', year: '2021', title: 'LOLA maps' }, { key: 'smith2020', author: 'Smith', year: '2020', title: 'Barker revisited' }, { key: 'xbar', author: 'X', year: '', title: '' }];
assert.deepEqual(citeMatches(entries, 'bar').map((e) => e.key), ['barker2021', 'xbar', 'smith2020']);
assert.deepEqual(citeMatches(entries, 'zzz'), []);
console.log('ok citation helpers');

assert.equal(window.Workspace.WRAPS, undefined, 'wrapper definitions remain private');
assert.equal(window.Workspace.wrapEdit, undefined, 'implementation helper remains private');
