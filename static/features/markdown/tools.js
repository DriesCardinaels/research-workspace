/* README authoring uses only the public text-session and Tool contracts. */
'use strict';
(() => {
  const {registry} = window.EditorTools;
  const headingPath = 'M3 5v14 M11 5v14 M3 12h8';
  const digits = ['M16 12l2-1v8 M16 19h4', 'M16 13a2 2 0 0 1 4 0c0 2-4 3-4 6h4', 'M16 11h4l-3 4h1a2 2 0 0 1 0 4h-2', 'M19 19v-8l-4 5h6', 'M20 11h-4v4h2a2 2 0 0 1 0 4h-2', 'M20 11h-2c-3 0-3 8 0 8a2 2 0 1 0 0-4h-2'];
  for (const [name, path] of Object.entries({
    mdHeading: 'M6 5v14 M18 5v14 M6 12h12',
    mdParagraph: 'M14 4v16 M18 4v16 M20 4H9a4 4 0 0 0 0 8h5',
    mdBulletList: 'M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
    mdNumberedList: 'M10 6h11 M10 12h11 M10 18h11 M3 3l1-1v5 M3 7h2 M2 11a1.5 1.5 0 0 1 3 0c0 1-3 2-3 4h3 M2 18h3l-2 2h1a1 1 0 0 1 0 2H2',
    mdTaskList: 'M10 6h11 M10 18h11 M2 3h5v6H2z M2 15h5v6H2z M3 6l1 1 2-2',
    mdImage: 'M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M17 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
    mdBadge: 'M4 4h10l7 7-10 10-8-8V5z M9 8h.01 M10 15l2 2 5-5',
    mdCodeBlock: 'M3 3h18v18H3z M8 9l-3 3 3 3 M16 9l3 3-3 3 M13 7l-2 10',
    mdDetails: 'M3 4h18v16H3z M3 10h18 M6 6l2 2 2-2 M7 14h10 M7 17h7',
    mdContents: 'M3 4h18 M3 10h3 M10 10h11 M3 16h3 M10 16h11 M10 21h11',
  })) window.EditorTools.icons.register(name, path);
  for (let index = 0; index < digits.length; index++) window.EditorTools.icons.register('mdHeading' + (index + 1), headingPath + ' ' + digits[index]);
  registry.contributeGroup('markdown.tools', {id:'markdown.heading',label:'Heading level',icon:'mdHeading',childArea:'markdown.headings'});
  for (let level = 0; level <= 6; level++) {
    registry.contribute('markdown.headings', {
      id: level ? 'markdown.heading.' + level : 'markdown.paragraph',
      label: level ? 'Heading ' + level + ' (H' + level + ')' : 'Paragraph',
      icon: level ? 'mdHeading' + level : 'mdParagraph', showText: true,
      enabled: ({previewMode}) => previewMode !== 'preview',
      /** Apply or replace ATX heading syntax on complete lines.
       * @param {object} context Public text session.
       * @pre Editable Markdown session. @post Heading level changes in one undoable edit.
       * @return {void} Nothing. @throws {Error} Session failures reach host dispatch.
       */
      execute: ({session}) => {
        session.transformLines(line => {
          const heading = line.match(/^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/);
          const text = heading ? (heading[1] || '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '') : line;
          return level ? '#'.repeat(level) + ' ' + (text || 'Heading') : text;
        });
      },
    });
  }
  const actions = [
    ['bold', 'Bold', 'bold', text => '**' + (text || 'bold text') + '**', 'Ctrl/Cmd+B'],
    ['italic', 'Italic', 'italic', text => '*' + (text || 'italic text') + '*', 'Ctrl/Cmd+I'],
    ['strike', 'Strikethrough', 'strike', text => '~~' + (text || 'text') + '~~'],
    ['link', 'Link', 'link', text => '[' + (text || 'Link text') + '](https://example.com)', 'Ctrl/Cmd+K'],
    ['image', 'Image or screenshot', 'mdImage', text => '![' + (text || 'Image description') + '](docs/screenshot.png)'],
    ['badge', 'Linked badge', 'mdBadge', text => '[![' + (text || 'Badge label') + '](https://img.shields.io/badge/status-active-brightgreen)](https://example.com)'],
    ['code', 'Inline code', 'code', text => '`' + (text || 'code') + '`'],
    ['codeblock', 'Fenced code block', 'mdCodeBlock', text => { const fence = '`'.repeat(Math.max(3, ...[...(text || '').matchAll(/`+/g)].map(match => match[0].length + 1))); return '\n' + fence + 'sh\n' + (text || 'python3 research_workbench.py') + '\n' + fence + '\n'; }],
    ['quote', 'Blockquote', 'blockQuote', text => (text || 'Quote').split(/\r?\n/).map(line => '> ' + line).join('\n')],
    ['list', 'Bulleted list', 'mdBulletList', text => (text || 'Item').split(/\r?\n/).map(line => '- ' + line).join('\n')],
    ['ordered', 'Numbered list', 'mdNumberedList', text => (text || 'First step\nSecond step').split(/\r?\n/).map((line, index) => (index + 1) + '. ' + line).join('\n')],
    ['task', 'Task list', 'mdTaskList', text => (text || 'Task').split(/\r?\n/).map(line => '- [ ] ' + line).join('\n')],
    ['table', 'Table', 'table', () => '\n\n| Feature | Description |\n| --- | --- |\n| Feature | Description |\n\n'],
    ['details', 'Collapsible section', 'mdDetails', text => '\n\n<details>\n<summary>Details</summary>\n\n' + (text || 'Additional information') + '\n\n</details>\n\n'],
    ['rule', 'Horizontal rule', 'minus', () => '\n\n---\n\n'],
  ];
  const primary = new Set(['bold', 'italic', 'code', 'quote', 'link', 'list', 'ordered', 'table']);
  for (const [id, label, icon, transform, shortcut] of actions) {
    window.EditorTools.registry.contribute(primary.has(id) ? 'markdown.tools' : 'markdown.extra', {
      showText: !primary.has(id), id: 'markdown.' + id, label, info: label + ' — insert Markdown at the selection', icon, shortcut,
      enabled: ({ previewMode }) => previewMode !== 'preview',
      /** Insert one undoable Markdown edit. @param {object} context Public session.
       * @pre Editable Markdown buffer. @post Selection replaced; save remains explicit.
       * @return {void} Nothing. @throws {Error} Session errors reach host dispatch.
       */
      execute: ({ session }) => { session.replaceSelection(transform(session.getSelection()).replace(/\r?\n/g, session.getText().includes('\r\n') ? '\r\n' : '\n')); },
    });
  }
  window.EditorTools.registry.contribute('markdown.extra', {
    showText: true, id: 'markdown.contents', label: 'Table of contents', icon: 'mdContents', enabled: ({ previewMode }) => previewMode !== 'preview',
    /** Insert links for current headings. @param {object} context Public session.
     * @pre Markdown model loaded. @post One native edit inserts current navigation.
     * @return {void} Nothing. @throws {Error} Session/model failure reaches host.
     */
    execute: ({ session }) => { session.replaceSelection(window.MarkdownPreview.contents(session.getText())); },
  });
  registry.contributeGroup('markdown.tools', {id:'markdown.more',label:'More Markdown tools',icon:'more',childArea:'markdown.extra'});
})();
