// Small, safe Markdown renderer for the review reports.
// Everything is HTML-escaped first; only a fixed set of tags is ever produced,
// so student code quoted in a report can never inject HTML or scripts.
(function (global) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w#+.-]*)/;
  const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  const indentOf = (l) => l.match(/^ */)[0].length;

  function inline(text) {
    const codes = [];
    let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
    return s;
  }

  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    const cells = [];
    let cur = '';
    let inCode = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '`') inCode = !inCode;
      if (c === '\\' && l[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function isBlockStart(lines, i) {
    const l = lines[i];
    return HEADING_RE.test(l) || FENCE_RE.test(l) || HR_RE.test(l) || /^\s*>/.test(l) ||
      LIST_RE.test(l) || (l.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]));
  }

  function renderFence(lines, i) {
    const m = FENCE_RE.exec(lines[i]);
    const indent = m[1].length;
    const fence = m[2];
    const lang = m[3];
    const body = [];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t.startsWith(fence[0].repeat(fence.length)) && t.replace(/[`~]/g, '') === '') { i++; break; }
      const l = lines[i];
      body.push(indentOf(l) >= indent ? l.slice(indent) : l.trimStart());
      i++;
    }
    const cls = lang ? ` class="lang-${esc(lang)}"` : '';
    const label = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
    return [`<pre>${label}<code${cls}>${esc(body.join('\n'))}</code></pre>`, i];
  }

  function renderList(lines, i) {
    const first = LIST_RE.exec(lines[i]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];

    while (i < lines.length) {
      const m = LIST_RE.exec(lines[i]);
      if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = indent + m[2].length + 1;
      const body = [m[3]];
      i++;
      let inFence = null;
      while (i < lines.length) {
        const l = lines[i];
        const ind = indentOf(l);
        const dedented = ind >= contentIndent ? l.slice(contentIndent) : l.slice(Math.min(ind, indent + 1)).trimStart();
        if (inFence) {
          body.push(ind >= contentIndent ? l.slice(contentIndent) : l.trimStart());
          if (l.trim().startsWith(inFence) && l.trim().replace(/[`~]/g, '') === '') inFence = null;
          i++;
          continue;
        }
        if (l.trim() === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && indentOf(lines[j]) > indent) { body.push(''); i++; continue; }
          break;
        }
        if (ind > indent) {
          const fm = FENCE_RE.exec(dedented);
          if (fm) inFence = fm[2];
          body.push(dedented);
          i++;
          continue;
        }
        if (!isBlockStart(lines, i) && body[body.length - 1] !== '') { body.push(l.trim()); i++; continue; }
        break;
      }
      items.push(body);
    }

    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    const html = items.map((b) => `<li>${renderBlocks(b, true)}</li>`).join('');
    return [`<${tag}${startAttr}>${html}</${tag}>`, i];
  }

  function renderTable(lines, i) {
    const head = splitRow(lines[i]);
    const aligns = splitRow(lines[i + 1]).map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
    i += 2;
    const rows = [];
    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
    const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
    const thead = `<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`;
    const tbody = `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k] || '', k)).join('')}</tr>`).join('')}</tbody>`;
    return [`<div class="table-wrap"><table>${thead}${tbody}</table></div>`, i];
  }

  function renderBlocks(lines, tight) {
    const out = [];
    let i = 0;
    const paragraphs = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { i++; continue; }

      let m;
      if (FENCE_RE.test(l)) { const [h, n] = renderFence(lines, i); out.push(h); i = n; continue; }
      if ((m = HEADING_RE.exec(l))) { const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (HR_RE.test(l)) { out.push('<hr>'); i++; continue; }
      if (l.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
        const [h, n] = renderTable(lines, i); out.push(h); i = n; continue;
      }
      if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote>${renderBlocks(q, false)}</blockquote>`);
        continue;
      }
      if (LIST_RE.test(l)) { const [h, n] = renderList(lines, i); out.push(h); i = n; continue; }

      const p = [];
      while (i < lines.length && lines[i].trim() !== '' && (p.length === 0 || !isBlockStart(lines, i))) {
        p.push(lines[i].trim());
        i++;
      }
      paragraphs.push(out.length);
      out.push(`<p>${p.map(inline).join('<br>')}</p>`);
    }
    if (tight && out.length === 1 && paragraphs.length === 1) return out[0].slice(3, -4);
    return out.join('\n');
  }

  function renderMarkdown(md) {
    return renderBlocks(String(md || '').replace(/\r\n?/g, '\n').split('\n'), false);
  }

  global.renderMarkdown = renderMarkdown;
})(typeof window !== 'undefined' ? window : globalThis);
