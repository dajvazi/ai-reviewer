// Code similarity using token normalization + winnowing (the technique behind MOSS).
// Renamed variables, changed literals, reformatting and edited comments do not hide
// copied code, because identifiers, strings and numbers are normalized away.

const SOURCE_EXT = new Set([
  'py', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  'cs', 'go', 'rb', 'php', 'kt', 'kts', 'swift', 'rs', 'scala', 'dart', 'm', 'vue', 'svelte',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'sql', 'sh', 'r', 'lua', 'pl', 'ipynb', 'jsp',
  'cshtml', 'razor', 'blade',
]);

const KEYWORDS = new Set((
  'if else elif for while do switch case default break continue return function def class ' +
  'struct interface enum new delete try catch except finally throw throws raise import from ' +
  'export as with async await yield lambda public private protected static final const let var ' +
  'void int float double long short char bool boolean string str true false null none nil ' +
  'undefined this self super extends implements package namespace using include in is not and ' +
  'or of typeof instanceof select insert update where join values into set echo print println ' +
  'printf require module go defer chan map range fn impl mut match type abstract virtual override'
).split(' '));

const TOKEN_RE = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\d[\w.]*|[A-Za-z_$][\w$]*|[^\s\w]/g;

export function isSource(path) {
  const base = path.split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 && SOURCE_EXT.has(base.slice(i + 1).toLowerCase());
}

export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    const c = t[0];
    if (t.startsWith('/*') || t.startsWith('//') || t.startsWith('<!--') || c === '#') continue;
    if (t.startsWith('"""') || t.startsWith("'''")) continue; // docstrings behave like comments
    if (c === '"' || c === "'" || c === '`') { out.push('S'); continue; }
    if (c >= '0' && c <= '9') { out.push('N'); continue; }
    if (/[A-Za-z_$]/.test(c)) { const l = t.toLowerCase(); out.push(KEYWORDS.has(l) ? l : 'V'); continue; }
    out.push(t);
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Winnowing fingerprints over k-grams of tokens. */
export function fingerprints(tokens, k = 12, w = 8) {
  const fp = new Set();
  if (tokens.length < k) return fp;
  const hashes = [];
  for (let i = 0; i + k <= tokens.length; i++) hashes.push(fnv1a(tokens.slice(i, i + k).join('\u0001')));
  if (hashes.length <= w) { fp.add(Math.min(...hashes)); return fp; }
  for (let i = 0; i + w <= hashes.length; i++) {
    let min = hashes[i];
    for (let j = i + 1; j < i + w; j++) if (hashes[j] < min) min = hashes[j];
    fp.add(min);
  }
  return fp;
}

function fileFingerprints(files, exclude) {
  const out = [];
  for (const f of files) {
    if (!isSource(f.path)) continue;
    const fp = fingerprints(tokenize(f.text));
    if (exclude) for (const h of exclude) fp.delete(h);
    if (fp.size >= 8) out.push({ path: f.path, fp });
  }
  return out;
}

// ---- Distinctive shared lines (strong fingerprints: identical comments, typos, strings) ----

const BORING_LINE = /^(import |from \S+ import|#include|using |package |require\(|const \w+ = require\(|export (default )?\{?|return (true|false|null|none|0|1);?$|\}|\{|\)|\]|<\/?\w+>$|else|try|catch|finally|break;?|continue;?|pass$)/i;

function normLine(l) { return l.trim().replace(/\s+/g, ' '); }

function distinctiveLines(files) {
  const map = new Map();
  for (const f of files) {
    f.text.split('\n').forEach((raw, i) => {
      const l = normLine(raw);
      if (l.length < 24 || !/[A-Za-z]{3}/.test(l) || BORING_LINE.test(l)) return;
      if (!map.has(l)) map.set(l, `${f.path}:${i + 1}`);
    });
  }
  return map;
}

function isCommentLike(l) { return /^(\/\/|#|\/\*|\*|<!--|--|"""|''')/.test(l); }

/**
 * Compare two repositories.
 * @param {{path,text}[]} filesA  primary repository files
 * @param {{path,text}[]} filesB  comparison repository files
 * @param {{path,text}[]} [starter] course starter code to exclude
 */
export function compareRepos(filesA, filesB, starter = []) {
  const starterFp = new Set();
  for (const f of starter) if (isSource(f.path)) for (const h of fingerprints(tokenize(f.text))) starterFp.add(h);

  const A = fileFingerprints(filesA, starterFp);
  const B = fileFingerprints(filesB, starterFp);

  // Inverted index over B.
  const index = new Map();
  B.forEach((b, bi) => { for (const h of b.fp) { let l = index.get(h); if (!l) index.set(h, (l = [])); l.push(bi); } });

  const pairs = [];
  let aMatched = 0;
  let aTotal = 0;
  const bMatchedHashes = new Set();
  A.forEach((a) => {
    const counts = new Map();
    for (const h of a.fp) {
      aTotal++;
      const l = index.get(h);
      if (l) { aMatched++; bMatchedHashes.add(h); for (const bi of l) counts.set(bi, (counts.get(bi) || 0) + 1); }
    }
    for (const [bi, shared] of counts) {
      const b = B[bi];
      const ofA = shared / a.fp.size;
      const ofB = shared / b.fp.size;
      const score = shared / Math.min(a.fp.size, b.fp.size);
      if (score >= 0.2 && shared >= 5) pairs.push({ fileA: a.path, fileB: b.path, shared, ofA, ofB, score });
    }
  });
  pairs.sort((x, y) => y.score - x.score || y.shared - x.shared);

  let bTotal = 0;
  for (const b of B) bTotal += b.fp.size;
  let bMatched = 0;
  for (const b of B) for (const h of b.fp) if (bMatchedHashes.has(h)) bMatched++;

  // Shared distinctive lines, excluding starter code lines.
  const starterLines = distinctiveLines(starter);
  const linesA = distinctiveLines(filesA);
  const linesB = distinctiveLines(filesB);
  const shared = [];
  for (const [l, locA] of linesA) {
    if (starterLines.has(l)) continue;
    const locB = linesB.get(l);
    if (locB) shared.push({ line: l.slice(0, 200), a: locA, b: locB, comment: isCommentLike(l) });
  }
  shared.sort((x, y) => (y.comment - x.comment) || (y.line.length - x.line.length));

  return {
    method: 'Token normalization + winnowing (k=12, w=8), MOSS-style. Identifiers, strings and numbers are normalized; comments ignored.',
    starterExcluded: starter.length > 0,
    sourceFilesA: A.length,
    sourceFilesB: B.length,
    overallAinB: aTotal ? aMatched / aTotal : 0,
    overallBinA: bTotal ? bMatched / bTotal : 0,
    topPairs: pairs.slice(0, 15),
    sharedDistinctiveLines: shared.slice(0, 40),
    sharedDistinctiveLinesTotal: shared.length,
  };
}
