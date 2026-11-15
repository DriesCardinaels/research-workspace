"""BibTeX and citation analysis; Unicode code-point ranges, no IO."""
import re

CITE_RE = re.compile(r'\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}')


BIB_DECL_RE = re.compile(r'\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]*)\}')


def strip_comments(text):
    """Blank LaTeX comments while retaining code-point positions.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Input text remains unchanged and output length matches input.
    @return str: Text with comments blanked
    @throws TypeError: Non-string input.

    Blank out LaTeX comments (a % not escaped by a backslash, to the end of the line), keeping offsets.
    """
    return re.sub(r'(?<!\\)%[^\n]*', lambda m: ' ' * len(m.group()), text)


def cite_uses(text):
    """Locate literal citation keys and their source positions.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Text remains unchanged; empty citations remain observable.
    @return list: Key, range and line records
    @throws TypeError: Non-string input.

    Each cite key in `text`: {key, start, end, line}; offsets are code points. Empty braces give key ''.
    """
    clean = strip_comments(text)
    out = []
    for m in CITE_RE.finditer(clean):
        inner, base = m.group(1), m.start(1)
        if not inner.strip():
            out.append({'key': '', 'start': m.start(), 'end': m.end(), 'line': clean.count('\n', 0, m.start()) + 1})
            continue
        pos = 0
        for part in inner.split(','):
            key = part.strip()
            if key and key != '*':
                start = base + pos + part.index(key)
                out.append({'key': key, 'start': start, 'end': start + len(key), 'line': clean.count('\n', 0, start) + 1})
            pos += len(part) + 1
    return out


def bib_declared(text):
    """List literal bibliography declarations in source order.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Text remains unchanged; missing .bib suffixes are supplied.
    @return list[str]: Declared bibliography filenames
    @throws TypeError: Non-string input.

    .bib files named by \bibliography{a,b} or \addbibresource{x.bib}.
    """
    names = []
    for m in BIB_DECL_RE.finditer(strip_comments(text)):
        for n in m.group(1).split(','):
            n = n.strip()
            if n:
                names.append(n if n.endswith('.bib') else n + '.bib')
    return names


def _braced(text, i):
    """Text inside the balanced braces that open at text[i]; returns (inner, index after the closing brace).

    @param text: Exact Unicode source/message; newline spelling is significant.
    @param i: Input used by the operation described above.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
    @return The computed value described above.
    @throws Validation/IO errors described above propagate; none for valid pure inputs.
    """
    depth, j = 0, i
    while j < len(text):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return text[i + 1:j], j + 1
        j += 1
    return text[i + 1:], len(text)


def _plain(value):
    """Compute plain for the owning operation.

    @param value: Input JSON value or bibliography field text.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
    @return The computed value described above.
    @throws Validation/IO errors described above propagate; none for valid pure inputs.
    """
    return re.sub(r'\s+', ' ', re.sub(r'[{}]|\\[A-Za-z]+\s*', '', value)).strip()


def parse_bib(text, detailed=False):
    """Parse brace/parenthesis BibTeX entries and top-level fields without evaluating macros.
    @param text: Complete bibliography source.
    @param detailed: Include metadata, authors and code-point ranges when true.
    @pre: Text is a Unicode string.
    @post: Source stays unchanged; malformed trailing records are skipped.
    @return: Entries in source order, including duplicate key occurrences.
    @throws TypeError: Text is not a string.
    Comments and nested/escaped values cannot introduce fake entries or fields. Unresolved
    macros remain literal for human review; malformed trailing entries are skipped.
    """
    entries, cursor = [], 0
    header = re.compile(r'@\s*([A-Za-z]+)\s*([\{(])')
    while cursor < len(text):
        m = header.search(text, cursor)
        if not m:
            break
        cursor = m.end()
        # A commented header is never a reference. Percent inside values is handled below.
        if re.search(r'(?<!\\)%', text[text.rfind('\n', 0, m.start()) + 1:m.start()]):
            continue
        closing = '}' if m.group(2) == '{' else ')'
        depth, quoted, i = 0, False, cursor
        while i < len(text):
            char = text[i]
            if char == '\\':
                i += 2
                continue
            if char == '%' and depth == 0 and not quoted and m.group(1).lower() != 'comment':
                newline = text.find('\n', i)
                i = len(text) if newline < 0 else newline + 1
                continue
            if char == '"' and depth == 0:
                quoted = not quoted
            if not quoted:
                if char == '{':
                    depth += 1
                elif char == '}' and depth:
                    depth -= 1
                elif char == closing and depth == 0:
                    break
            i += 1
        if i == len(text):
            break
        body_start = cursor
        body, cursor = text[cursor:i], i + 1
        kind = m.group(1).lower()
        if kind in ('string', 'comment', 'preamble') or ',' not in body:
            continue
        raw_key, body = body.split(',', 1)
        key = raw_key.strip()
        if not key or re.search(r'\s', key):
            continue
        fields, field_ranges, pos = {}, {}, 0
        fields_start = body_start + len(raw_key) + 1
        while pos < len(body):
            skip = re.match(r'(?:[\s,]+|%[^\n]*(?:\n|$))*', body[pos:])
            pos += skip.end()
            field = re.match(r'([A-Za-z][\w-]*)\s*=\s*', body[pos:])
            if not field:
                break
            pos += field.end()
            begin, depth, quoted = pos, 0, False
            while pos < len(body):
                char = body[pos]
                if char == '\\':
                    pos += 2
                    continue
                if char == '"' and depth == 0:
                    quoted = not quoted
                if not quoted:
                    if char == '{':
                        depth += 1
                    elif char == '}':
                        depth -= 1
                    elif char == ',' and depth == 0:
                        break
                pos += 1
            value = body[begin:pos].strip()
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            fields.setdefault(field.group(1).lower(), _plain(value))
            field_ranges.setdefault(field.group(1).lower(), {
                'start': fields_start + begin,
                'end': fields_start + pos - (len(body[begin:pos]) - len(body[begin:pos].rstrip())),
            })
        authors = [a.strip() for a in re.split(r'\s+and\s+', fields.get('author', '')) if a.strip()]
        surname = lambda a: a.split(',')[0].strip() if ',' in a else a.split()[-1]
        short = ''
        if authors:
            short = surname(authors[0]) + (' et al.' if len(authors) > 2 else ' and ' + surname(authors[1]) if len(authors) == 2 else '')
        entry = {'key': key, 'type': kind, 'title': fields.get('title', ''), 'author': short,
                 'year': fields.get('year', '')}
        if detailed:
            key_start = body_start + len(raw_key) - len(raw_key.lstrip())
            entry.update(fields=fields, authors=authors, start=m.start(), end=cursor,
                         key_start=key_start, key_end=key_start + len(key), field_ranges=field_ranges)
        entries.append(entry)
    return entries

