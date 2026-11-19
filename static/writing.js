/* Writing analysis for LaTeX source: sentence marks from fixed rules, and readability
 * scores. Pure functions; tested in Node (tests/test_writing.mjs).
 *
 * Every mark comes from a rule in RULES, so the same text always gives the same marks.
 * Offsets are UTF-16 offsets into the source text (CodeMirror's units).
 */
'use strict';
(function (global) {
  // ------------------------------------------------------------ rules
  // Word lists follow ~/.claude/rules/hci-writing.md (Harvard HUIT readable content and Dries's rules).
  const INTENSIFIERS = ['very', 'entirely', 'highly', 'clearly', 'extremely', 'really', 'truly', 'totally', 'absolutely', 'quite', 'obviously'];
  const PLAIN = {
    utilize: 'use', utilizes: 'use', utilized: 'used', utilizing: 'using', utilization: 'use',
    retain: 'keep', retains: 'keeps', retained: 'kept', obtain: 'get', obtains: 'gets', obtained: 'got',
    facilitate: 'help', facilitates: 'helps', commence: 'start', numerous: 'many', approximately: 'about',
    demonstrate: 'show', demonstrates: 'shows', demonstrated: 'showed', sufficient: 'enough', additional: 'more',
    'in order to': 'to', 'prior to': 'before', 'a number of': 'some', 'with regard to': 'about', 'in the event that': 'if',
  };
  const HYPE = ['novel', 'seamless', 'seamlessly', 'powerful', 'crucial', 'groundbreaking', 'cutting-edge', 'revolutionary', 'game-changing'];
  const BRITISH = /\b(colour\w*|centre\w*|neighbour\w*|modelling|modelled|organis\w*|summaris\w*|recognis\w*|behaviour\w*|labelled|labelling|metres?|favour\w*|grey|catalogue|analys(?:e|ed|es|ing)|optimis\w*|minimis\w*|maximis\w*|visualis\w*|normalis\w*|characteris\w*|prioritis\w*|emphasis(?:e|ed|es))\b/gi;
  const BE = 'am|is|are|was|were|be|been|being';
  const IRREGULAR = 'built|chosen|done|drawn|found|given|held|kept|known|left|made|meant|read|run|seen|set|shown|taken|told|written|brought|bought|caught|sent|spent|thought|understood|led|lost|put|cut|hidden|begun|broken|driven|eaten|forgotten|gotten|grown|hit|laid|paid|said|sold|spoken|stolen|struck|sung|thrown|worn|won';

  const RULES = [
    { id: 'long', label: 'Long sentence', on: true, kind: 'sentence', why: 'More than 25 words. Split it, or move part to its own sentence. Start the new sentence from something the first one named, and keep the link that a joining word such as “so” or a colon gave.' },
    { id: 'commas', label: 'Comma chain', on: true, kind: 'sentence', why: 'Two or more commas in one sentence. One comma after a short linking phrase at the front is fine; keep that phrase, as it often links to the sentence before. Split at another comma or move a phrase to the front. After a split, start the new sentence from something the first one named.' },
    { id: 'parens', label: 'Parentheses', on: false, kind: 'span', why: 'No parentheses in prose. Rewrite the sentence or remove the aside.' },
    { id: 'intensifier', label: 'Intensifier', on: false, kind: 'span', why: 'Choose the precise word instead of an intensifier.' },
    { id: 'plain', label: 'Plain word', on: false, kind: 'span', why: 'A shorter, plainer word exists.' },
    { id: 'hype', label: 'Hype', on: false, kind: 'span', why: 'Avoid hype words; say what the thing does.' },
    { id: 'british', label: 'British spelling', on: false, kind: 'span', why: 'The paper uses US spelling.' },
    { id: 'citepage', label: 'Page in citation', on: false, kind: 'span', why: 'Cite without page numbers: \\cite{key}.' },
    { id: 'bare-this', label: 'Bare “this”', on: false, kind: 'span', possible: true, why: '“This” without a noun can point to several things. Possible issue: name what “this” is.' },
    { id: 'passive', label: 'Passive voice', on: false, kind: 'span', possible: true, why: 'Possible passive voice. If so, name the actor and use the active voice.' },
  ];

  // ------------------------------------------------------------ LaTeX -> prose mask
  // References vanish from prose (footnotes too, except in a word count).
  const REFS = /\\(?:cite[a-z]*|ref|cref|Cref|autoref|eqref|label|input|include|url|href)\*?(?:\[[^\]]*\])*\{[^}]*\}/g;
  const REFS_FOOT = /\\(?:cite[a-z]*|ref|cref|Cref|autoref|eqref|label|input|include|url|href|footnote)\*?(?:\[[^\]]*\])*\{[^}]*\}/g;
  // Metadata commands: blanked with every {…} and […] argument that follows.
  const META = /\\(?:ccsdesc|keywords|author|affiliation|institution|department|streetaddress|city|state|postcode|country|email|orcid|additionalaffiliation|authornote|authorsaddresses|shortauthors|renewcommand\*?|newcommand\*?|setcopyright|copyrightyear|acmYear|acmDOI|acmISBN|acmConference|acmBooktitle|acmPrice|acmJournal|acmVolume|acmNumber|acmArticle|acmMonth|acmSubmissionID|received|settopmatter|thanks|subtitle|titlenote|subtitlenote|bibliographystyle|bibliography|includegraphics|fancyhead|fancyfoot|fancyhf|pagestyle|thispagestyle|setlength|addtolength|setcounter|vspace\*?|hspace\*?)(?![a-zA-Z])\*?/g;
  // Same length as the source: characters that are not prose become spaces, so offsets stay valid.
  // Breaks ('\n\n') mark places where a sentence must end (headings, items, environments).
  // counting: the mask for a word count. Footnote text stays; math is not words and goes.
  // Headings and captions do not count (for now), as in the prose mask.
  function proseMask(src, { counting = false, spelling = false } = {}) {
    const out = src.split('');
    const blank = (a, b, brk = false) => {
      for (let i = a; i < b && i < out.length; i++) out[i] = out[i] === '\n' ? '\n' : ' ';
      if (brk && !spelling && b - a >= 2) { out[a] = '\n'; out[a + 1] = '\n'; }
    };
    const each = (re, fn) => { for (const m of src.matchAll(re)) fn(m); };
    // End (exclusive) of the balanced {…} or […] group opening at k, or -1.
    const group = (k) => {
      const open = src[k], close = open === '{' ? '}' : open === '[' ? ']' : null;
      if (!close) return -1;
      for (let e = k, depth = 0; e < src.length; e++) {
        if (src[e] === '\\') { e++; continue; }
        if (src[e] === open) depth++;
        else if (src[e] === close && --depth === 0) return e + 1;
      }
      return -1;
    };
    // Keep only the text of \cmd[…]{text}: blank the command, options and the outer braces.
    const keepArg = (m) => {
      let k = m.index + m[0].length;
      while (src[k] === '[') { const e = group(k); if (e < 0) return; k = e; }
      const e = group(k);
      if (e < 0) { blank(m.index, k); return; }
      blank(m.index, k + 1, true);
      blank(e - 1, e);
      return [k + 1, e - 1];
    };
    const doc = src.indexOf('\\begin{document}');
    if (doc >= 0) blank(0, doc + 16, true);
    const end = src.indexOf('\\end{document}');
    if (end >= 0) blank(end, src.length, true);
    each(/(?<!\\)%[^\n]*/g, (m) => blank(m.index, m.index + m[0].length));
    // Spelling includes captions in floats; table code, math and literal environments stay opaque.
    const opaqueEnvironments = spelling ? 'tabular|equation|align|verbatim|lstlisting|tikzpicture' : 'figure|table|tabular|equation|align|verbatim|lstlisting|tikzpicture';
    each(new RegExp(String.raw`\\begin\{(${opaqueEnvironments})\*?\}[\s\S]*?\\end\{\1\*?\}`, 'g'), (m) => blank(m.index, m.index + m[0].length, true));
    // Front matter and metadata (acmart): not prose, so the command and all its arguments go.
    each(/\\begin\{CCSXML\}[\s\S]*?\\end\{CCSXML\}/g, (m) => blank(m.index, m.index + m[0].length, true));
    for (const m of src.matchAll(META)) {
      let j = m.index + m[0].length;
      for (;;) {
        let k = j;
        while (k < src.length && /\s/.test(src[k]) && !(src[k] === '\n' && src[k + 1] === '\n')) k++;
        const e = group(k);
        if (e < 0) break;
        j = e;
      }
      blank(m.index, j, true);
    }
    each(/\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?/g, (m) => blank(m.index, m.index + m[0].length, true));
    // Math: one placeholder word, as readability.py does.
    each(/\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\])*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, (m) => { blank(m.index, m.index + m[0].length); if (!counting) out[m.index] = 'X'; });
    // Headings, captions and alt text (\Description) are not sentences, and they do not count as words.
    if (!spelling) each(/\\(?:section|subsection|subsubsection|paragraph|caption|title|Description)\*?(?:\[[^\]]*\])?\{(?:[^{}]|\{[^{}]*\})*\}/g, (m) => blank(m.index, m.index + m[0].length, true));
    if (counting || spelling) each(/\\footnote\*?/g, keepArg); // a footnote's text counts as words
    each(/\\item\b(?:\[[^\]]*\])?/g, (m) => blank(m.index, m.index + m[0].length, true));
    // References vanish; macros used as numbers read as a number.
    each(counting || spelling ? REFS : REFS_FOOT, (m) => blank(m.index, m.index + m[0].length));
    // siunitx: \num{…}, \qty{…}{\meter}, \qtyrange{…}{…}{…} and kin read as one number; a unit other
    // than % or ° is one more word ("2 m"), as in the PDF. Arguments may be macros (\qty{\ExRMS}{\meter}).
    const siWords = []; // written last: the steps below blank by source match
    each(/\\(num|qty|ang|unit|numrange|qtyrange|numlist|qtylist|numproduct|qtyproduct)(?![a-zA-Z])/g, (m) => {
      if (out[m.index] !== '\\') return; // inside math, already blanked
      let k = m.index + m[0].length;
      while (src[k] === '[') { const e = group(k); if (e < 0) return; k = e; }
      const args = [];
      for (let e; src[k] === '{' && (e = group(k)) > 0; k = e) args.push([k, e]);
      if (!args.length) return;
      blank(m.index, k);
      const unit = m[1] === 'unit' || m[1].startsWith('qty') ? src.slice(...args[args.length - 1]) : '';
      if (m[1] !== 'unit') siWords.push([m.index, '9']);
      if (unit && !/^\{\\(?:percent|degree|arcminute|arcsecond)\}$/.test(unit)) siWords.push([k - 2, 'u']);
    });
    each(/\\[a-zA-Z]+\{\}/g, (m) => { blank(m.index, m.index + m[0].length); out[m.index] = '9'; });
    each(/\\[a-zA-Z]+\*?/g, (m) => blank(m.index, m.index + m[0].length));
    // Spacing commands (\, \; \: \!) are spaces, not punctuation: "2\,m" has no comma.
    each(/(?<!\\)\\[,;:!]/g, (m) => blank(m.index, m.index + 2));
    each(/\\[%$&#_{}]/g, (m) => { out[m.index] = ' '; });
    each(/[{}~\\]/g, (m) => { if (out[m.index] !== '\n') out[m.index] = ' '; });
    // A comma between digits in braces ("1{,}000") is part of the number (after braces go).
    each(/(?<=\p{N})\{,\}(?=\p{N})/gu, (m) => { out[m.index] = out[m.index + 1] = out[m.index + 2] = '9'; });
    each(/``|''/g, (m) => { out[m.index] = '"'; out[m.index + 1] = ' '; });
    for (const [i, c] of siWords) out[i] = c;
    return out.join('');
  }

  // ------------------------------------------------------------ sentences
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  const ABBREV = /\b(?:e\.g|i\.e|et al|etc|Fig|Figs|Sec|Eq|vs|cf|approx|resp|Dr|Mr|Ms|No)\.$/;

  // Sentences as {start, end, text} in source offsets; text is the masked prose.
  function sentences(src, mask = proseMask(src)) {
    const out = [];
    let start = null;
    const push = (end) => {
      if (start === null) return;
      const s = start; start = null;
      let e = end;
      while (e > s && /\s/.test(mask[e - 1])) e--;
      const text = mask.slice(s, e).replace(/\s+/g, ' ').trim();
      if ((text.match(WORD) || []).length >= 3) out.push({ start: s, end: e, text });
    };
    for (let i = 0; i < mask.length; i++) {
      const c = mask[i];
      if (c === '\n' && mask[i + 1] === '\n') { push(i); continue; }
      if (start === null) { if (/[\p{L}\p{N}"(]/u.test(c)) start = i; continue; }
      if (/[.!?]/.test(c)) {
        let j = i + 1;
        while (j < mask.length && /["')\]]/.test(mask[j])) j++;
        if (j < mask.length && !/\s/.test(mask[j])) continue;
        let k = j;
        while (k < mask.length && /\s/.test(mask[k])) k++;
        const next = mask[k];
        if (next !== undefined && !/[\p{Lu}\p{N}"(]/u.test(next)) continue; // "et al. argue", "e.g. a"
        if (ABBREV.test(mask.slice(Math.max(0, i - 8), i + 1)) && next !== undefined && !/\n/.test(mask.slice(j, k + 1))) continue;
        push(j);
      }
    }
    push(mask.length);
    return out;
  }

  // ------------------------------------------------------------ readability
  // Vowel groups with fixes for silent endings and split vowel pairs. Within about 1% of textstat's
  // syllable totals on the hallmark paper (tests/test_writing.mjs; check in the README).
  function syllables(word) {
    let w = word.toLowerCase().replace(/['’]s$/, '').replace(/[^a-z]/g, '');
    if (!w) return 0;
    w = w.replace(/qu/g, 'qw').replace(/y(?=[aeiou])/g, 'j');
    let n = (w.match(/[aeiouy]+/g) || []).length;
    if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) n -= 1;
    if (/[^aeiouy]ed$/.test(w) && !/[td]ed$/.test(w)) n -= 1;
    if (/[^aeiouy]es$/.test(w) && !/(?:[sxz]|[cs]h|[cg]|[^aeiouy]l)es$/.test(w)) n -= 1;
    n -= (w.match(/[^aeiouy]e(?=(?:ly|ment|ful|less|ness|wise|work|fore|line|lines)$)/g) || []).length;
    n += (w.match(/(?<![stcgx])(?:ia|io)|eo|ua|uo|iu|ie(?=n?t|r)/g) || []).length;
    return Math.max(1, n);
  }
  const wordSyllables = (w) => /^\d/.test(w) ? 1 : w.split('-').filter(Boolean).reduce((t, p) => t + syllables(p), 0) || 1;

  function readability(list) {
    let words = 0, syl = 0;
    for (const s of list) for (const w of s.text.match(WORD) || []) { words++; syl += wordSyllables(w); }
    const n = list.length;
    if (!n || !words) return null;
    const wps = words / n, spw = syl / words;
    return {
      sentences: n, words, wordsPerSentence: wps,
      fre: 206.835 - 1.015 * wps - 84.6 * spw,
      fkGrade: 0.39 * wps + 11.8 * spw - 15.59,
      long: list.filter((s) => (s.text.match(WORD) || []).length > 25).length,
    };
  }

  // ------------------------------------------------------------ word count
  // Written words only: running text and footnotes. Headings, captions, commands and their arguments,
  // references, math, comments and braces do not count. "human--robot" is two words; "3.5" is one.
  const COUNT_WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'’]|-(?!-)|[.,](?=\p{N}))*/gu;
  const wordMask = (src) => proseMask(src, { counting: true });
  // Words in mask[start, end). A word cut by the range counts once.
  function countWords(mask, start = 0, end = mask.length) {
    while (start > 0 && /[\p{L}\p{N}'’.,-]/u.test(mask[start - 1]) && /[\p{L}\p{N}'’.,-]/u.test(mask[start])) start--;
    return (mask.slice(start, end).match(COUNT_WORD) || []).length;
  }

  // ------------------------------------------------------------ marks
  const wordRe = (list) => new RegExp(`\\b(?:${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
  const INT_RE = wordRe(INTENSIFIERS), PLAIN_RE = wordRe(Object.keys(PLAIN)), HYPE_RE = wordRe(HYPE);
  const PASSIVE_RE = new RegExp(`\\b(?:${BE})\\s+(?:\\w+ly\\s+)?(\\w+ed|${IRREGULAR})\\b`, 'gi');
  const BARE_THIS = /(^|[.!?]\s+)(This|These)\s+(is|are|was|were|shows?|means?|makes?|leads?|allows?|gives?|requires?|creates?|enables?|helps?|has|have|can|will|would|also)\b/g;

  // Marks for a whole file: {rule, start, end, sentence, text, hint}. Sentence marks span the sentence.
  function analyze(src) {
    const mask = proseMask(src);
    const list = sentences(src, mask);
    const marks = [];
    const add = (rule, start, end, sentence, hint) => marks.push({ rule, start, end, sentence, text: src.slice(start, end), ...(hint ? { hint } : {}) });
    list.forEach((s, n) => {
      const words = (s.text.match(WORD) || []).length;
      if (words > 25) add('long', s.start, s.end, n, `${words} words`);
      const commas = (s.text.match(/,/g) || []).length;
      if (commas >= 2) add('commas', s.start, s.end, n, `${commas} commas`);
      const seg = mask.slice(s.start, s.end);
      const at = (re, rule, hint) => { for (const m of seg.matchAll(re)) add(rule, s.start + m.index, s.start + m.index + m[0].length, n, hint?.(m)); };
      at(/\([^()]*\)/g, 'parens');
      at(INT_RE, 'intensifier');
      at(PLAIN_RE, 'plain', (m) => `“${m[0]}” → “${PLAIN[m[0].toLowerCase().replace(/\s+/g, ' ')]}”`);
      at(HYPE_RE, 'hype');
      at(BRITISH, 'british');
      for (const m of seg.matchAll(PASSIVE_RE)) {
        const p = m[1].toLowerCase();
        if (/^(?:need|used|based|related|interested|concerned|supposed|tired|bored)$/.test(p)) continue; // usually adjectives
        add('passive', s.start + m.index, s.start + m.index + m[0].length, n);
      }
      for (const m of seg.matchAll(BARE_THIS)) {
        const i = m.index + m[1].length;
        add('bare-this', s.start + i, s.start + i + m[2].length, n);
      }
    });
    // Page numbers in citations live in the LaTeX markup, not in the prose.
    for (const m of src.matchAll(/\\cite[a-z]*\*?\[[^\]]*\]\{[^}]*\}/g)) {
      const k = list.findIndex((s) => m.index >= s.start && m.index < s.end + 40);
      add('citepage', m.index, m.index + m[0].length, k);
    }
    marks.sort((a, b) => a.start - b.start || a.end - b.end);
    return { sentences: list, marks, scores: readability(list) };
  }

  // A stable key for "ignore here": the rule plus the sentence's words.
  function fingerprint(rule, sentenceText) {
    let h = 2166136261;
    const s = rule + '|' + sentenceText.toLowerCase().replace(/\s+/g, ' ').trim();
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  const Writing = { RULES, proseMask, sentences, syllables, readability, analyze, fingerprint, wordMask, countWords };
  if (typeof module !== 'undefined') module.exports = Writing;
  global.WritingCheck = Writing;
})(typeof window !== 'undefined' ? window : globalThis);
