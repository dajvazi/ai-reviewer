(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('review-form');
  const els = {
    password: $('password'), remember: $('remember'), submit: $('submit'), cancel: $('cancel'),
    formError: $('form-error'), status: $('status'), statusText: $('status-text'), meta: $('meta'),
    toolbar: $('toolbar'), notice: $('notice'), empty: $('empty'), report: $('report'),
    recentList: $('recent-list'), recentEmpty: $('recent-empty'),
  };

  const PW_KEY = 'reviewer.password';
  const RECENT_KEY = 'reviewer.recent';
  const MAX_RECENT = 12;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  let controller = null;
  let markdown = '';
  let current = null; // { repo, sha, compare, date }
  let renderQueued = false;

  // ---------- password ----------
  const savedPw = store.get(PW_KEY);
  if (savedPw) { els.password.value = savedPw; els.remember.checked = true; }
  els.remember.addEventListener('change', () => { if (!els.remember.checked) store.del(PW_KEY); });

  // ---------- rendering ----------
  function decorate(html) {
    return html.replace(/<h3>\[(Critical|High|Medium|Low)\]\s*/g,
      (_, s) => `<h3><span class="sev sev-${s.toLowerCase()}">${s}</span>`);
  }

  function render(streaming) {
    renderQueued = false;
    els.report.innerHTML = decorate(window.renderMarkdown(markdown));
    els.report.classList.toggle('cursor', !!streaming);
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => requestAnimationFrame(() => render(true)), 200);
  }

  function setStatus(text, busy) {
    els.status.hidden = !text;
    els.statusText.textContent = text || '';
    els.status.classList.toggle('idle', !busy);
  }

  function showNotice(text, kind) {
    els.notice.hidden = !text;
    els.notice.textContent = text || '';
    els.notice.className = 'notice' + (kind ? ' ' + kind : '');
  }

  function chip(html) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.innerHTML = html;
    return span;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function showMeta(m) {
    els.meta.innerHTML = '';
    els.meta.appendChild(chip(`${esc(m.repo)} @ <code>${esc(m.sha.slice(0, 7))}</code>`));
    els.meta.appendChild(chip(`${m.files} files read${m.omitted ? `, ${m.omitted} over budget` : ''}`));
    if (m.compare && m.similarity) {
      const pct = (x) => (x * 100).toFixed(0) + '%';
      els.meta.appendChild(chip(`vs ${esc(m.compare)}: ${pct(m.similarity.aInB)} / ${pct(m.similarity.bInA)} overlap`));
    }
    els.meta.appendChild(chip(esc(modelLabel(m.model))));
    els.meta.hidden = false;
  }

  function modelLabel(id) {
    const [name, ...ver] = String(id).replace(/^claude-/, '').split('-');
    return name.charAt(0).toUpperCase() + name.slice(1) + (ver.length ? ' ' + ver.join('.') : '');
  }

  function resetView() {
    markdown = '';
    current = null;
    els.report.innerHTML = '';
    els.report.hidden = true;
    els.empty.hidden = true;
    els.meta.hidden = true;
    els.meta.innerHTML = '';
    els.toolbar.hidden = true;
    showNotice('');
    els.formError.hidden = true;
  }

  function busy(on) {
    els.submit.disabled = on;
    els.submit.textContent = on ? 'Reviewing…' : 'Review project';
    els.cancel.hidden = !on;
  }

  // ---------- submit ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.password) return formError('Enter the password.');
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test((data.repoUrl || '').trim())) {
      return formError('Enter a repository URL like https://github.com/owner/repo');
    }
    if (els.remember.checked) store.set(PW_KEY, data.password);

    resetView();
    busy(true);
    setStatus('Starting…', true);
    controller = new AbortController();

    let res;
    try {
      res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
    } catch (err) {
      return finish(err.name === 'AbortError' ? 'Cancelled.' : 'Could not reach the server.', 'error');
    }

    if (!res.ok) {
      let msg = `Request failed (${res.status}).`;
      try { msg = (await res.json()).error || msg; } catch { /* keep */ }
      if (res.status === 401) { store.del(PW_KEY); els.password.focus(); }
      setStatus('');
      busy(false);
      els.empty.hidden = false;
      return formError(msg);
    }

    await readStream(res);
  });

  els.cancel.addEventListener('click', () => controller?.abort());

  function formError(msg) {
    els.formError.textContent = msg;
    els.formError.hidden = false;
  }

  async function readStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let errored = false;
    let done = null;

    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'status') setStatus(evt.message, true);
          else if (evt.type === 'meta') {
            current = { repo: evt.repo, sha: evt.sha, compare: evt.compare, date: new Date().toISOString() };
            showMeta(evt);
          } else if (evt.type === 'text') {
            if (els.report.hidden) { els.report.hidden = false; setStatus('Writing the review…', true); }
            markdown += evt.text;
            queueRender();
          } else if (evt.type === 'error') {
            errored = true;
            showNotice(evt.message, 'error');
          } else if (evt.type === 'done') {
            done = evt;
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return finish('Cancelled. The partial review is shown below.', 'warn');
      return finish('The connection was interrupted. The partial review is shown below.', 'warn');
    }

    if (errored) return finish(null);
    if (!done) return finish('The review stopped before it finished (the server may have hit its time limit). Try the faster Sonnet model.', 'warn');
    if (done.stopReason === 'max_tokens') return finish('The review hit its length limit and may be cut off at the end.', 'warn', done);
    return finish(null, null, done);
  }

  function finish(msg, kind, done) {
    controller = null;
    busy(false);
    if (msg) showNotice(msg, kind);
    if (markdown) {
      render(false);
      els.toolbar.hidden = false;
      saveRecent();
    } else if (!msg && els.notice.hidden) {
      els.empty.hidden = false;
    }
    if (done?.usage) {
      const u = done.usage;
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      setStatus(`Done · ${input.toLocaleString()} input tokens · ${(u.output_tokens || 0).toLocaleString()} output tokens`, false);
    } else {
      setStatus(markdown ? 'Stopped' : '', false);
    }
  }

  // ---------- toolbar ----------
  function fileName() {
    const base = current ? `review-${current.repo.replace('/', '-')}-${current.sha.slice(0, 7)}` : 'review';
    return `${base}.md`;
  }

  $('copy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(markdown); flash(e.target, 'Copied'); }
    catch { flash(e.target, 'Copy failed'); }
  });
  $('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('print').addEventListener('click', () => window.print());

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }

  // ---------- recent reviews ----------
  function loadRecent() {
    try { return JSON.parse(store.get(RECENT_KEY) || '[]'); } catch { return []; }
  }

  function saveRecent() {
    if (!current || !markdown) return;
    const m = markdown.match(/\*\*Final score:\*\*\s*([\d.]+)\s*\/\s*10/i);
    const entry = { ...current, score: m ? m[1] : null, markdown };
    let list = loadRecent().filter((r) => !(r.repo === entry.repo && r.sha === entry.sha && r.compare === entry.compare));
    list.unshift(entry);
    list = list.slice(0, MAX_RECENT);
    while (list.length && !store.set(RECENT_KEY, JSON.stringify(list))) list.pop(); // shrink if storage is full
    drawRecent();
  }

  function drawRecent() {
    const list = loadRecent();
    els.recentList.innerHTML = '';
    els.recentEmpty.hidden = list.length > 0;
    list.forEach((r, i) => {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      const date = new Date(r.date);
      open.title = `${r.repo}${r.compare ? ' vs ' + r.compare : ''} · ${date.toLocaleString()}`;
      open.innerHTML = `<span class="name">${esc(r.repo)}${r.compare ? ' <span class="muted">vs</span> ' + esc(r.compare) : ''}</span><span class="score">${r.score ? esc(r.score) + '/10' : '—'}</span>`;
      open.addEventListener('click', () => openRecent(r));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.setAttribute('aria-label', `Remove ${r.repo} from recent reviews`);
      del.textContent = '×';
      del.addEventListener('click', () => {
        const next = loadRecent();
        next.splice(i, 1);
        store.set(RECENT_KEY, JSON.stringify(next));
        drawRecent();
      });
      li.append(open, del);
      els.recentList.appendChild(li);
    });
  }

  function openRecent(r) {
    if (controller) return;
    resetView();
    markdown = r.markdown;
    current = { repo: r.repo, sha: r.sha, compare: r.compare, date: r.date };
    els.meta.appendChild(chip(`${esc(r.repo)} @ <code>${esc(r.sha.slice(0, 7))}</code>`));
    els.meta.appendChild(chip(`saved ${esc(new Date(r.date).toLocaleDateString())}`));
    els.meta.hidden = false;
    els.report.hidden = false;
    render(false);
    els.toolbar.hidden = false;
    setStatus('');
    if (window.innerWidth < 960) els.report.scrollIntoView({ behavior: 'smooth' });
  }

  drawRecent();
})();
