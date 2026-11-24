// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Byte-identical output, reimplemented hot paths: fused single-pass Markdown,
// cached slugs, cached link resolution, array-joined template rendering,
// scanning (non-splitting) front matter. All state is per run() call:
// nothing is cached from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESC[c]);
}
function longDate(date) {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < plain.length; i++) if (plain.charCodeAt(i) > 127) { ascii = false; break; }
  if (!ascii) {
    plain = plain.normalize('NFKD').replace(/\p{M}/gu, '');
    ascii = true;
    for (let i = 0; i < plain.length; i++) if (plain.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let a = 0, b = out.length;
    while (a < b && out.charCodeAt(a) === 45) a++;
    while (b > a && out.charCodeAt(b - 1) === 45) b--;
    out = out.slice(a, b);
    if (out.length > 64) out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    return out === '' ? 'untitled' : out;
  }
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}
function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const sp = c <= 32 ? (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13)
      : (c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter
const KEYS_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) { y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10); }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // slug must not start with '-'
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) { if (prevDash) ok = false; prevDash = true; }
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false; // must not end with '-'
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  if ((firstNL === -1 ? text : text.slice(0, firstNL)) !== '---') return { error: 'no front matter' };
  if (firstNL === -1) return { error: 'the front matter is not closed' };
  // Scan FM lines; body starts after the closing '---' line.
  const fmLines = [];
  let start = firstNL + 1, lineIdx = 1, bodyStart = -1;
  for (;;) {
    const e = text.indexOf('\n', start);
    const end = e === -1 ? text.length : e;
    if (text.slice(start, end) === '---') { bodyStart = e === -1 ? text.length : e + 1; break; }
    fmLines.push([text.slice(start, end), lineIdx + 1]);
    if (e === -1) return { error: 'the front matter is not closed' };
    start = e + 1; lineIdx++;
  }
  const data = {};
  for (let li = 0; li < fmLines.length; li++) {
    const line = fmLines[li][0], num = fmLines[li][1];
    let blank = true;
    for (let k = 0; k < line.length; k++) { const ch = line.charCodeAt(k); if (ch !== 32 && ch !== 9) { blank = false; break; } }
    if (blank) continue;
    if (line.charCodeAt(0) === 35) continue; // '#'
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${num} is not "key: value"` };
    const key = line.slice(0, colon);
    let keyOk = true;
    for (let k = 0; k < key.length; k++) { const c = key.charCodeAt(k); if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; } }
    if (!keyOk) return { error: `line ${num} is not "key: value"` };
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${num} is not "key: value"` };
    // trailing spaces/tabs dropped
    let re = raw.length;
    while (re > 0) { const c = raw.charCodeAt(re - 1); if (c !== 32 && c !== 9) break; re--; }
    if (re !== raw.length) raw = raw.slice(0, re);
    if (!KEYS_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function escChar(ch) { const e = ESC[ch]; return e === undefined ? ch : e; }
// Is the char at `j` escaped? A run of backslashes immediately before it:
// odd run -> the last backslash escapes it (the char is escapable in every call site).
function isEscaped(s, j) {
  let cnt = 0;
  for (let b = j - 1; b >= 0 && s.charCodeAt(b) === 92; b--) cnt++;
  return (cnt & 1) === 1;
}
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}
const SPECIAL_RE = /[\\`*\[&<>"']/g;
function inline(s, env) {
  let parts = null, plain = 0, pos = 0;
  const n = s.length;
  for (;;) {
    SPECIAL_RE.lastIndex = pos;
    const m = SPECIAL_RE.exec(s);
    if (m === null) break;
    const i = m.index, c = m[0];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) { if (parts === null) parts = []; parts.push(s.slice(plain, i)); }
        if (parts === null) parts = []; parts.push(escChar(s[i + 1]));
        plain = i + 2; pos = i + 2;
      } else pos = i + 1;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) { if (parts === null) parts = []; parts.push(s.slice(plain, i)); }
        if (parts === null) parts = []; parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        plain = j + 1; pos = j + 1;
      } else pos = i + 1;
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) { if (parts === null) parts = []; parts.push(s.slice(plain, i)); }
          if (parts === null) parts = []; parts.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          plain = j + 2; pos = j + 2;
        } else pos = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) { if (parts === null) parts = []; parts.push(s.slice(plain, i)); }
        if (parts === null) parts = []; parts.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
        plain = j + 1; pos = j + 1;
      } else pos = i + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (i > plain) { if (parts === null) parts = []; parts.push(s.slice(plain, i)); }
        if (parts === null) parts = [];
        parts.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        plain = mm + 1; pos = mm + 1;
      } else pos = i + 1;
      continue;
    }
    // & < > " '
    if (i > plain) { if (parts === null) parts = []; parts.push(s.slice(plain, i)); }
    if (parts === null) parts = []; parts.push(ESC[c]);
    plain = i + 1; pos = i + 1;
  }
  if (parts === null) return s;
  if (n > plain) parts.push(s.slice(plain, n));
  return parts.join('');
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c !== 32 && c !== 9) break; a++; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c !== 32 && c !== 9) break; b--; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
// fence open: returns lang string, or null. fence close: boolean.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length) return null;
  let c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length) { c = line.charCodeAt(a); if (c !== 32 && c !== 9) break; a++; }
  let b = line.length;
  while (b > a) { c = line.charCodeAt(b - 1); if (c !== 32 && c !== 9) break; b--; }
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}
function isHr(line) {
  const d = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const s = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!d && !s) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpen(line) !== null; // '`'
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 45 || c === 42) return isHr(line); // '-' or '*'
  if (c === 32 || c === 9 || line.length === 0) return isBlank(line);
  return false;
}
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || line.length === 0) {
      if (isBlank(line)) { i++; continue; }
      // non-blank indented line: a paragraph (fall through below)
    } else if (c0 === 96) { // '`'
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < L && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '';
        for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
        blocks.push(`<pre><code${fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`}>${code}</code></pre>`);
        continue;
      }
      // not a fence: a paragraph
    } else if (c0 === 35) { // '#'
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
      // not a heading: a paragraph
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
      // not a break: maybe a list (fall through to the list check)
    } else if (c0 === 62) { // '>'
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) { const t = trimLine(body[k]); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const isBullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
      let orderedStart = -1;
      if (!isBullet) {
        let d = 0;
        while (d < line.length) { const c = line.charCodeAt(d); if (c < 48 || c > 57) break; d++; }
        if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) orderedStart = Number(line.slice(0, d));
      }
      if (isBullet || orderedStart !== -1) {
        const isOrdered = orderedStart !== -1;
        const items = [];
        while (i < L) {
          const cur = lines[i];
          let itemText = null;
          if (isOrdered) {
            let d = 0;
            while (d < cur.length) { const c = cur.charCodeAt(d); if (c < 48 || c > 57) break; d++; }
            if (d >= 1 && d <= 9 && cur.charCodeAt(d) === 46 && cur.charCodeAt(d + 1) === 32) itemText = cur.slice(d + 2);
          } else if ((cur.charCodeAt(0) === 45 || cur.charCodeAt(0) === 42) && cur.charCodeAt(1) === 32) {
            itemText = cur.slice(2);
          }
          if (itemText !== null) { items.push([trimLine(itemText)]); i++; }
          else if (/^ {2,}\S/.test(cur)) { items[items.length - 1].push(trimLine(cur)); i++; }
          else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && orderedStart !== 1 ? `<ol start="${orderedStart}">` : `<${tag}>`;
        let inner = '';
        for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates
const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
class TemplateError extends Error {}
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', k: 0, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, k: tok.t === 'var' ? 1 : 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', k: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', k: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.k) {
      case 0: out.push(n.text); break;
      case 1: {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out.push(escapeHtml(v));
        else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
        else if (Array.isArray(v)) out.push(escapeHtml(textOf(v)));
        else out.push('');
        break;
      }
      case 2: out.push(textOf(lookup(scope, n.path))); break;
      case 3: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = ['posts', 'tags', 'page'];

export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) { v = slugifySlow(text); slugCache.set(text, v); }
    return v;
  };
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }
  // sources, sorted by path
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [], statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }
  // front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data; s.body = fm.body; s.text = null;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let k = 1; k < RESERVED.length; k++) if (s.path.startsWith(RESERVED[k] + '/')) { own = RESERVED[k]; break; }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const link = (target) => {
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35) return target; // '/' or '#'
      // scheme? [A-Za-z][A-Za-z0-9+.-]*:
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        let scheme = false;
        for (let i = 1; i < target.length; i++) {
          const c = target.charCodeAt(i);
          if (c === 58) { scheme = true; break; }
          if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) break;
        }
        if (scheme) return target;
      }
      const key = dir + '\n' + target;
      let path = linkCache.get(key);
      if (path === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        path = rel === '' ? null : resolvePath(dir, rel);
        linkCache.set(key, path);
      }
      const hash = target.indexOf('#');
      const frag = hash === -1 ? '' : target.slice(hash);
      let out;
      if (path !== null && bySource.has(path)) out = `${bySource.get(path).url}${frag}`;
      else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
      else { broken.add(`broken-link ${spath} -> ${target}`); out = target; }
      return out;
    };
    const md = renderMarkdown(s.body, { link }, slugify);
    s.html = md.html; s.toc = md.toc; s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
    s.body = null;
  }
  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  // tags
  const ownTags = (s) => {
    const seen = new Set(), out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i], slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push({ name, slug }); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // cards / pages
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong });
  for (const s of kept) {
    s.tagCards = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.tocCards = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    s.card = {
      title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong,
      summary: s.data.summary ?? '', excerpt: s.excerpt, reading_minutes: s.readingMinutes, tags: s.tagCards,
    };
  }
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, {
      page: { ...s.card, slug: s.slug, content: s.html, toc: s.tocCards, newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
