"""Pure review diff and anchor relocation rules. Inputs use code-point offsets."""
import re
import difflib

TOKEN = re.compile(r'\s+|\w+|[^\w\s]')


def _tokens(text):
    """Compute tokens for the owning operation.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
    @return The computed value described above.
    @throws Validation/IO errors described above propagate; none for valid pure inputs.
    """
    out, pos = [], 0
    for m in TOKEN.finditer(text):
        out.append((m.group(), pos))
        pos = m.end()
    return out


def word_changes(old, new):
    """Compute review hunks with word-level source ranges.

    @param old: Base Unicode source.
    @param new: Current Unicode source.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Inputs remain unchanged; whitespace-only hunks are omitted.
    @return list[dict]: Old/new text and code-point ranges
    @throws TypeError,AttributeError: Non-string input.

    Word-level hunks between two texts.

    Returns dicts with character offsets into both texts. Hunks separated by
    at most two unchanged tokens (one word and a space) are merged, so a
    rewritten phrase reads as one replacement.
    """
    old_lines, new_lines = old.splitlines(keepends=True), new.splitlines(keepends=True)
    old_starts, new_starts = [0], [0]
    for line in old_lines:
        old_starts.append(old_starts[-1] + len(line))
    for line in new_lines:
        new_starts.append(new_starts[-1] + len(line))
    hunks = []
    line_matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    for tag, i1, i2, j1, j2 in line_matcher.get_opcodes():
        if tag == 'equal':
            continue
        o0, o1 = old_starts[i1], old_starts[i2]
        n0, n1 = new_starts[j1], new_starts[j2]
        ot, nt = _tokens(old[o0:o1]), _tokens(new[n0:n1])
        matcher = difflib.SequenceMatcher(None, [t for t, _ in ot], [t for t, _ in nt], autojunk=False)
        ops = [op for op in matcher.get_opcodes()]
        merged = []
        for k, (t, a1, a2, b1, b2) in enumerate(ops):
            if t == 'equal':
                continue
            gap_small = (merged and k > 0 and ops[k - 1][0] == 'equal' and
                         ops[k - 1][2] - ops[k - 1][1] <= 2 and merged[-1][1] == ops[k - 1][1])
            if gap_small:
                merged[-1] = [merged[-1][0], a2, merged[-1][2], b2]
            else:
                merged.append([a1, a2, b1, b2])
        for a1, a2, b1, b2 in merged:
            def offset(tokens, i, base, text_len):
                """Compute offset for the owning operation.

                @param tokens: Input used by the operation described above.
                @param i: Input used by the operation described above.
                @param base: Input used by the operation described above.
                @param text_len: Input used by the operation described above.
                @pre Inputs satisfy the operation description; dependencies are initialized.
                @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
                @return The computed value described above.
                @throws Validation/IO errors described above propagate; none for valid pure inputs.
                """
                return base + (tokens[i][1] if i < len(tokens) else text_len)
            os_, oe = offset(ot, a1, o0, o1 - o0), offset(ot, a2, o0, o1 - o0)
            ns, ne = offset(nt, b1, n0, n1 - n0), offset(nt, b2, n0, n1 - n0)
            # Leading and trailing whitespace is not part of a change.
            while os_ < oe and ns < ne and old[os_] == new[ns] and old[os_].isspace():
                os_ += 1
                ns += 1
            while os_ < oe and ns < ne and old[oe - 1] == new[ne - 1] and old[oe - 1].isspace():
                oe -= 1
                ne -= 1
            # Slide a pure removal or insertion right past punctuation and spaces, so
            # ". Each result" (with the period kept after it) reads "Each result. ".
            if ns == ne:
                while oe < len(old) and old[os_] == old[oe] and not old[os_].isalnum():
                    os_, oe, ns, ne = os_ + 1, oe + 1, ns + 1, ne + 1
            elif os_ == oe:
                while ne < len(new) and new[ns] == new[ne] and not new[ns].isalnum():
                    os_, oe, ns, ne = os_ + 1, oe + 1, ns + 1, ne + 1
            if old[os_:oe].strip() == '' and new[ns:ne].strip() == '':
                continue  # whitespace-only edits (rewrapping) are not reported
            hunks.append({'base_start': os_, 'base_end': oe, 'new_start': ns, 'new_end': ne,
                          'old': old[os_:oe], 'new': new[ns:ne]})
    return hunks


def line_of(text, offset):
    """Convert a code-point offset to a one-based line.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @param offset: Code-point offset into the source.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Inputs remain unchanged.
    @return int: One-based source line
    @throws TypeError: Invalid input types.
    """
    return text.count('\n', 0, offset) + 1


def _common_suffix(a, b, limit=80):
    """Compute common suffix for the owning operation.

    @param a: Input used by the operation described above.
    @param b: Input used by the operation described above.
    @param limit: Input used by the operation described above.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
    @return The computed value described above.
    @throws Validation/IO errors described above propagate; none for valid pure inputs.
    """
    n = 0
    while n < min(len(a), len(b), limit) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def _common_prefix(a, b, limit=80):
    """Compute common prefix for the owning operation.

    @param a: Input used by the operation described above.
    @param b: Input used by the operation described above.
    @param limit: Input used by the operation described above.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
    @return The computed value described above.
    @throws Validation/IO errors described above propagate; none for valid pure inputs.
    """
    n = 0
    while n < min(len(a), len(b), limit) and a[n] == b[n]:
        n += 1
    return n


_SENTENCE_END = re.compile(r'[.!?](?:\}|\)|\'\'|")*(?=\s)|\n\s*\n')


def _between_sentences(text, before, after, near, size):
    """Text between the end of the previous sentence and the start of the next one.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @param before: Input used by the operation described above.
    @param after: Input used by the operation described above.
    @param near: Input used by the operation described above.
    @param size: Input used by the operation described above.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
    @return The computed value described above.
    @throws Validation/IO errors described above propagate; none for valid pure inputs.
    """
    ends = [m.end() for m in _SENTENCE_END.finditer(before)]
    starts = [m.end() for m in _SENTENCE_END.finditer(after)]
    befores = [before[:k][-40:] for k in reversed(ends[-2:])]
    afters = [after[k:].lstrip()[:40] for k in starts[:2]]
    for b in befores:
        if len(b.strip()) < 8:
            continue
        hits = [m.end() for m in re.finditer(re.escape(b), text)]
        if not hits:
            continue
        i = min(hits, key=lambda h: abs(h - near))
        for a in afters:
            if len(a.strip()) < 8:
                continue
            j = text.find(a, i)
            if j != -1 and j - i <= 3 * size + 600:
                seg = text[i:j]
                lead = len(seg) - len(seg.lstrip())
                return i + lead, max(i + lead, i + len(seg.rstrip()))
        return i + (len(text[i:]) - len(text[i:].lstrip())), i + (len(text[i:]) - len(text[i:].lstrip()))
    return None


def relocate(text, note):
    """Relocate a review anchor after its surrounding source changes.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @param note: Source anchor containing quote, context and prior range.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Source and note are unchanged.
    @return tuple: Start, end and relocation status
    @throws TypeError,KeyError: Malformed text or anchor record.

    Find a comment's passage again after the source changed.

    Returns (start, end, anchor): 'ok' when the quoted text is found (among
    repeats, the one whose surroundings match best, then the nearest),
    'edited' when only the surroundings are found (the passage itself was
    rewritten), 'lost' when neither is found.
    """
    s, e, quote = note['start'], note['end'], note['quote']
    before, after = note.get('before', ''), note.get('after', '')
    if text[s:e] == quote and (_common_suffix(text[:s], before) >= min(len(before), 20) or not before):
        return s, e, 'ok'
    hits = [m.start() for m in re.finditer(re.escape(quote), text)] if quote else []
    if hits:
        def score(h):
            """Compute score for the owning operation.

            @param h: Input used by the operation described above.
            @pre Inputs satisfy the operation description; dependencies are initialized.
            @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
            @return The computed value described above.
            @throws Validation/IO errors described above propagate; none for valid pure inputs.
            """
            ctx = _common_suffix(text[max(0, h - 80):h], before) + _common_prefix(text[h + len(quote):h + len(quote) + 80], after)
            return (-ctx, abs(h - s))
        i = min(hits, key=score)
        return i, i + len(quote), 'ok'
    b, a = before[-40:], after[:40]
    starts = [m.end() for m in re.finditer(re.escape(b), text)] if b.strip() else []
    if starts:
        i = min(starts, key=lambda h: abs(h - s))
        j = text.find(a, i) if a.strip() else -1
        if j != -1 and j - i <= 3 * len(quote) + 200:
            return i, j, 'edited'
        return i, i, 'edited'
    # The sentence around the passage was rewritten too: anchor between the neighboring sentences.
    found = _between_sentences(text, before, after, s, len(quote))
    if found:
        return found[0], found[1], 'edited'
    if a.strip():
        # Nothing usable before it (start of the file): anchor on the text after it.
        ends = [m.start() for m in re.finditer(re.escape(a), text)]
        if ends:
            j = min(ends, key=lambda h: abs(h - e))
            k = text.rfind('\n\n', 0, j)
            return max(0, k + 2 if k >= 0 and j - k <= 3 * len(quote) + 200 else max(0, j - len(quote))), j, 'edited'
    n = len(text)
    return min(s, n), min(e, n), 'lost'

