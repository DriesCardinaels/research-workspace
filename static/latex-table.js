/* Package-free LaTeX tables. Public entry points: LatexTable.edit and LatexTableDialog.open.
 * Selected cells are plain text: tabs separate columns and newlines separate rows.
 */
'use strict';
(function () {
  class LatexTable {
    /** Build a table edit without changing the source.
     * @param {string} text Complete source buffer.
     * @param {number} from Inclusive UTF-16 selection offset.
     * @param {number} to Exclusive UTF-16 selection offset.
     * @param {object} options Optional rows (1–100), columns (1–30), alignment (l/c/r per column), caption and label.
     * @pre Offsets identify one editable source range; selected content is plain tab-separated text.
     * @post Input values are unchanged; special LaTeX characters in cells/caption are escaped.
     * @return {object} Replacement range, insertion text and selection around the first cell.
     * @throws {TypeError|RangeError} Invalid source, range, dimensions, alignment, label or ragged cell data.
     */
    static edit(text, from, to, options = {}) {
      if (typeof text !== 'string' || !options || typeof options !== 'object') throw new TypeError('Source and table options are required');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > text.length) throw new RangeError('Invalid source selection');
      const selected = text.slice(from, to).replace(/\r\n/g, '\n').replace(/\n$/, '');
      const cells = selected ? selected.split('\n').map(line => line.split('\t')) : null;
      const rows = options.rows ?? cells?.length ?? 3;
      const columns = options.columns ?? cells?.[0].length ?? 2;
      if (!Number.isInteger(rows) || rows < 1 || rows > 100 || !Number.isInteger(columns) || columns < 1 || columns > 30)
        throw new RangeError('Use 1–100 rows and 1–30 columns');
      if (cells && (cells.length !== rows || cells.some(row => row.length !== columns)))
        throw new RangeError('Selected text must have the requested rows and the same number of tab-separated cells in every row');
      const alignment = options.alignment ?? 'l'.repeat(columns);
      if (typeof alignment !== 'string' || alignment.length !== columns || !/^[lcr]+$/.test(alignment))
        throw new TypeError('Alignment must contain one l, c or r per column');
      const caption = options.caption ?? '', label = options.label ?? '';
      if (typeof caption !== 'string' || typeof label !== 'string') throw new TypeError('Caption and label must be text');
      if (label && !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(label)) throw new TypeError('Label must use letters, digits, colon, dot, underscore or hyphen');
      if (label && !caption.trim()) throw new TypeError('A labeled table needs a caption for correct numbering');
      const nl = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = ['\\begin{table}[htbp]', '  \\centering'];
      if (caption.trim()) lines.push('  \\caption{' + LatexTable.#escape(caption) + '}');
      if (label) lines.push('  \\label{' + label + '}');
      lines.push('  \\begin{tabular}{' + alignment + '}', '    \\hline');
      const first = from + (from > 0 && text[from - 1] !== '\n' ? nl.length : 0) + lines.join(nl).length + nl.length + 4;
      let firstCell = '';
      for (let row = 0; row < rows; row++) {
        const values = Array.from({ length: columns }, (_, column) => LatexTable.#escape(cells ? cells[row][column] : `Cell ${row + 1},${column + 1}`));
        if (!row) firstCell = values[0];
        lines.push('    ' + values.join(' & ') + ' \\\\');
      }
      lines.push('    \\hline', '  \\end{tabular}', '\\end{table}');
      const lead = from > 0 && text[from - 1] !== '\n' ? nl : '';
      const tail = to < text.length && text[to] !== '\n' ? nl : '';
      return { from, to, insert: lead + lines.join(nl) + tail, selFrom: first, selTo: first + firstCell.length };
    }
    /** Escape literal text in one pass, preserving Unicode.
     * @param {string} value Plain cell or caption text.
     * @pre Value is a string.
     * @post No input is modified; generated escapes are not re-escaped.
     * @return {string} Text safe for a standard LaTeX tabular cell.
     * @throws {TypeError} Value is not a string.
     */
    static #escape(value) {
      const escapes = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
      return value.replace(/[\\&%$#_{}~^]/g, char => escapes[char]);
    }
  }
  class LatexTableDialog {
    /** Open an accessible table form for the current selection.
     * @param {Workspace} workspace Public getSourceSelection() and insertTable(options) provider.
     * @pre An editable LaTeX buffer is active; the caller handles initialization failures.
     * @post A modal form is mounted; successful submission inserts one undoable edit and removes the form.
     * @return {HTMLDialogElement} Mounted dialog; invalid submissions retain values and show an error.
     * @throws {Error} Selection access or dialog initialization failure; submission failures are reported locally.
     */
    static open(workspace) {
      const selection = workspace.getSourceSelection();
      const lines = selection.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
      const dialog = document.createElement('dialog');
      dialog.className = 'ws-table-dialog'; dialog.setAttribute('aria-label', 'Insert LaTeX table');
      const form = document.createElement('form');
      const heading = document.createElement('h3'); heading.textContent = 'Insert LaTeX table';
      const description = document.createElement('p'); description.textContent = 'Select tab-separated text to convert cells, or insert an editable table. Cell text and captions are escaped as literal text.';
      form.append(heading, description);
      const fields = {};
      for (const [name, title, type, value, max] of [
        ['rows', 'Rows', 'number', selection ? lines.length : 3, 100],
        ['columns', 'Columns', 'number', selection ? lines[0].split('\t').length : 2, 30],
        ['alignment', 'Alignment (one l, c or r per column; blank means left)', 'text', '', null],
        ['caption', 'Caption (optional)', 'text', '', null],
        ['label', 'Label (optional; requires caption)', 'text', '', null],
      ]) {
        const label = document.createElement('label'), input = document.createElement('input');
        label.textContent = title; input.name = name; input.type = type; input.value = String(value);
        if (max) { input.min = '1'; input.max = String(max); input.required = true; }
        label.append(input); form.append(label); fields[name] = input;
      }
      const error = document.createElement('p'); error.setAttribute('role', 'alert');
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Insert table';
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      submit.className = 'primary'; actions.append(cancel, submit); form.append(error, actions); dialog.append(form);
      window.EditorTools.Tool.bind(cancel, { id: 'table.cancel', label: 'Cancel table insertion', showText: true, execute: () => dialog.close() });
      dialog.addEventListener('close', () => dialog.remove());
      window.EditorTools.Tool.submit(form, submit, { id: 'table.insert', label: 'Insert table', showText: true, execute: () => {
        try {
          // The dialog owns recovery: keep all input values when validation or editing fails.
          if (workspace.getSourceSelection() !== selection) throw new Error('Source selection changed. Close and reopen the table form.');
          workspace.insertTable({ rows: Number(fields.rows.value), columns: Number(fields.columns.value),
            ...(fields.alignment.value ? { alignment: fields.alignment.value } : {}), caption: fields.caption.value, label: fields.label.value });
          dialog.close();
        } catch (failure) { error.textContent = failure.message; }
      } });
      document.body.append(dialog);
      try { window.EditorPanes.open(dialog); fields.rows.focus(); }
      catch (failure) { dialog.remove(); throw failure; }
      return dialog;
    }
  }
  window.LatexTable = LatexTable;
  window.LatexTableDialog = LatexTableDialog;
  if (window.EditorTools) window.EditorTools.sourceCommands.register({
    id: 'table', name: 'Table', label: 'Insert a LaTeX table or convert selected tab-separated text', group: 'structure',
    icon: window.EditorTools.icons.markup('table'),
    execute: workspace => LatexTableDialog.open(workspace),
  });
})();
