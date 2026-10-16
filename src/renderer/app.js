'use strict';

(() => {
  const api = window.ballApi;
  const $ = (sel, root = document) => root.querySelector(sel);
  const EMOJI = ['🎃', '👻', '🦇', '🕷️', '💀', '🧙', '🎄', '⭐', '🎂', '💖', '🦄', '🐉', '🌈', '🚀'];

  let themes = [];
  let status = { mounted: false, usbSeen: false };
  let info = { ffmpeg: true };
  let openId = null;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const byId = (id) => themes.find((t) => t.id === id);

  function toast(message, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = message;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), bad ? 9000 : 5000);
  }

  async function guard(fn) {
    try {
      return await fn();
    } catch (err) {
      toast(err.message || String(err), true);
      return undefined;
    }
  }

  // ------------------------------------------------------------ status bar

  function applyBlockReason(theme) {
    if (status.busy) return 'The ball is busy…';
    if (!status.mounted) return 'Plug in the ball first';
    if (!theme.clips.length) return 'Add some clips first';
    return '';
  }

  function renderStatus() {
    const el = $('#status');
    $('#connect-help').hidden = Boolean(status.mounted);
    if (status.mounted) {
      const showing = status.onBall?.themeId ? byId(status.onBall.themeId) : null;
      const what = showing
        ? `showing ${esc(showing.emoji)} ${esc(showing.name)}`
        : status.onBall
          ? `${plural(status.onBall.count, 'clip')} on it`
          : 'checking…';
      el.innerHTML = `
        <span class="pill"><span class="dot good"></span>Ball connected · ${what}${status.free ? ` · ${mb(status.free)} free` : ''}</span>
        <button class="btn small" id="eject" ${status.busy ? 'disabled' : ''}>Eject</button>`;
      $('#eject').onclick = () => ejectBall();
    } else if (status.usbSeen) {
      el.innerHTML = '<span class="pill"><span class="dot warn"></span>Ball found, waiting for its storage…</span>';
    } else {
      el.innerHTML = '<span class="pill"><span class="dot"></span>No ball connected</span>';
    }
    updateCards();
  }

  // ------------------------------------------------------------ theme cards

  function preview(theme, cls = '') {
    const first = theme.clips[0];
    return `<div class="ball ${cls}">${
      first
        ? `<video muted playsinline autoplay preload="auto" src="${esc(first.url)}" data-theme="${esc(theme.id)}" data-i="0"></video>`
        : `<div class="empty">${esc(theme.emoji)}</div>`
    }</div>`;
  }

  // Cycle each card's preview through the theme's clips, like the ball does.
  function wirePreviews(root) {
    root.querySelectorAll('video[data-theme]').forEach((v) => {
      v.addEventListener('ended', () => {
        const t = byId(v.dataset.theme);
        if (!t || !t.clips.length) return;
        const i = (Number(v.dataset.i) + 1) % t.clips.length;
        v.dataset.i = String(i);
        v.src = t.clips[i].url;
        v.play().catch(() => {});
      });
      v.play().catch(() => {});
    });
  }

  function renderThemes() {
    const grid = $('#themes');
    grid.innerHTML =
      themes
        .map(
          (t) => `
      <article class="card" data-id="${esc(t.id)}">
        <span class="badge" hidden>On the ball</span>
        ${preview(t)}
        <h3>${esc(t.emoji)} ${esc(t.name)}</h3>
        <p class="meta">${t.clips.length ? `${plural(t.clips.length, 'clip')} · ${mb(t.bytes)}` : 'No clips yet'}${t.builtin ? ' · built in' : ''}</p>
        <div class="buttons">
          <button class="btn primary" data-act="apply">Show on the ball</button>
          <button class="btn" data-act="open">Open</button>
        </div>
      </article>`,
        )
        .join('') +
      `<button class="card new" id="new-theme"><span class="plus">+</span>New theme</button>`;

    grid.querySelectorAll('.card[data-id]').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-act="apply"]').onclick = () => applyTheme(id);
      card.querySelector('[data-act="open"]').onclick = () => openTheme(id);
    });
    $('#new-theme').onclick = () => openNewTheme();
    wirePreviews(grid);
    updateCards();
  }

  function updateCards() {
    document.querySelectorAll('.card[data-id]').forEach((card) => {
      const t = byId(card.dataset.id);
      if (!t) return;
      const current = status.mounted && status.onBall?.themeId === t.id;
      card.classList.toggle('current', current);
      card.querySelector('.badge').hidden = !current;
      const btn = card.querySelector('[data-act="apply"]');
      const reason = applyBlockReason(t);
      btn.disabled = Boolean(reason);
      btn.title = reason;
    });
    const sheetBtn = $('#theme-dialog [data-act="apply"]');
    if (sheetBtn && openId && byId(openId)) {
      const reason = applyBlockReason(byId(openId));
      sheetBtn.disabled = Boolean(reason);
      sheetBtn.title = reason;
    }
  }

  async function reloadThemes() {
    themes = await api.listThemes();
    renderThemes();
    renderStatus();
    if (openId && byId(openId) && $('#theme-dialog').open) renderThemeSheet(openId);
  }

  // ------------------------------------------------------------ theme sheet

  function openTheme(id) {
    openId = id;
    renderThemeSheet(id);
    const d = $('#theme-dialog');
    if (!d.open) d.showModal();
  }

  function renderThemeSheet(id) {
    const t = byId(id);
    const d = $('#theme-dialog');
    if (!t) return d.close();
    const editable = !t.builtin;
    d.innerHTML = `
      <div class="sheet-head">
        <h2 id="sheet-title">${esc(t.emoji)} ${esc(t.name)}</h2>
        ${editable ? '<button class="btn small" id="rename">Rename</button>' : ''}
        <button class="btn small ghost" id="close-sheet" aria-label="Close">✕</button>
      </div>
      <div class="sheet-body">
        ${t.note ? `<p class="hint">${esc(t.note)}</p>` : ''}
        ${
          t.clips.length
            ? `<div class="clips">${t.clips
                .map(
                  (c) => `
              <div class="clip">
                <div class="ball small"><video muted playsinline loop preload="metadata" src="${esc(c.url)}#t=4"></video></div>
                <span class="title">${esc(c.title)}</span>
                ${editable ? `<button class="remove" data-file="${esc(c.file)}" aria-label="Remove ${esc(c.title)}">✕</button>` : ''}
              </div>`,
                )
                .join('')}</div>`
            : `<p class="hint">No clips yet. Add some below.</p>`
        }
        ${
          editable
            ? `
          <div class="dropzone" id="drop">
            <span class="big">Drop videos or pictures here</span>
            <span class="hint">MP4, MOV, GIF, JPG, PNG and iPhone photos all work. They’re resized for the round screen.</span>
            <div class="fit" role="radiogroup" aria-label="How to fit pictures">
              <label><input type="radio" name="fit" value="fill" checked /> Fill the circle</label>
              <label><input type="radio" name="fit" value="fit" /> Show the whole picture</label>
            </div>
            <button class="btn" id="pick">Choose files…</button>
            <div id="convert" hidden style="width:100%">
              <p class="hint" id="convert-label"></p>
              <div class="progress"><div id="convert-bar"></div></div>
            </div>
            ${info.ffmpeg ? '' : '<p class="hint">To add clips, install ffmpeg first: <code>brew install ffmpeg</code></p>'}
          </div>`
            : '<p class="hint">This theme comes with the app. Make a new theme to add your own clips.</p>'
        }
      </div>
      <div class="sheet-foot">
        ${editable ? '<button class="btn danger" id="delete">Delete theme</button>' : ''}
        <button class="btn" id="reveal">Show in Finder</button>
        <span class="spacer"></span>
        <button class="btn primary" data-act="apply">Show on the ball</button>
      </div>`;

    $('#close-sheet', d).onclick = () => d.close();
    $('#reveal', d).onclick = () => guard(() => api.revealTheme(id));
    $('[data-act="apply"]', d).onclick = () => {
      d.close();
      applyTheme(id);
    };
    d.querySelectorAll('.clip video').forEach((v) => {
      v.addEventListener('mouseenter', () => v.play().catch(() => {}));
      v.addEventListener('mouseleave', () => v.pause());
    });
    updateCards();
    if (!editable) return;

    $('#rename', d).onclick = () => {
      const h2 = $('#sheet-title', d);
      h2.innerHTML = `<input class="rename" value="${esc(t.name)}" maxlength="60" aria-label="Theme name" />`;
      const input = $('input', h2);
      input.focus();
      input.select();
      const done = async (save) => {
        input.onblur = null;
        if (save && input.value.trim() && input.value.trim() !== t.name) {
          await guard(() => api.updateTheme(id, { name: input.value.trim() }));
        }
        await reloadThemes();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') {
          e.preventDefault();
          done(false);
        }
      };
      input.onblur = () => done(true);
    };
    $('#delete', d).onclick = async () => {
      if (!confirm(`Delete “${t.name}”? Its clips go to the Bin, so you can still get them back.`)) return;
      await guard(() => api.removeTheme(id));
      d.close();
      openId = null;
      await reloadThemes();
    };
    d.querySelectorAll('.remove').forEach((b) => {
      b.onclick = async () => {
        await guard(() => api.removeClip(id, b.dataset.file));
        await reloadThemes();
      };
    });

    const drop = $('#drop', d);
    const fit = () => $('input[name="fit"]:checked', d)?.value || 'fill';
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      addFiles(id, paths, fit());
    });
    $('#pick', d).onclick = async () => {
      const paths = await guard(() => api.pickFiles());
      if (paths?.length) addFiles(id, paths, fit());
    };
  }

  async function addFiles(id, paths, fit) {
    if (!paths.length) return;
    $('#convert').hidden = false;
    $('#pick').disabled = true;
    const res = await guard(() => api.addFiles(id, paths, fit));
    if (res) {
      res.errors.forEach((e) => toast(e, true));
      const added = paths.length - res.errors.length;
      if (added) toast(`Added ${plural(added, 'clip')}.`);
    }
    await reloadThemes();
  }

  api.on('convert:progress', (p) => {
    const label = $('#convert-label');
    const bar = $('#convert-bar');
    if (!label || !bar || p.done) return;
    label.textContent = `Getting ${p.name} ready for the ball (${p.index + 1} of ${p.total})…`;
    bar.style.width = `${Math.round(((p.index + (p.progress || 0)) / p.total) * 100)}%`;
  });

  // ------------------------------------------------------------ new theme

  function openNewTheme() {
    const d = $('#new-dialog');
    $('#new-name').value = '';
    $('#new-emoji').innerHTML = EMOJI.map(
      (e, i) => `<label><input type="radio" name="emoji" value="${e}" ${i === 0 ? 'checked' : ''} /><span>${e}</span></label>`,
    ).join('');
    $('[data-close]', d).onclick = () => d.close();
    d.showModal();
    $('#new-name').focus();
  }

  $('#new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#new-name').value.trim();
    if (!name) return;
    const emoji = $('input[name="emoji"]:checked', $('#new-form'))?.value || '✨';
    const t = await guard(() => api.createTheme(name, emoji));
    $('#new-dialog').close();
    if (t) {
      await reloadThemes();
      openTheme(t.id);
    }
  });

  // ------------------------------------------------------------ apply + eject

  const STEP_TEXT = {
    checking: 'Checking what’s on the ball…',
    saving: (p) => `Keeping a copy of ${plural(p.total, 'video')} already on the ball…`,
    clearing: 'Making room…',
    copying: (p) => `Copying ${p.index + 1} of ${p.total}…`,
    done: 'Finishing up…',
  };

  let applyUnsub = null;

  async function applyTheme(id) {
    const t = byId(id);
    if (!t || applyBlockReason(t)) return;
    const d = $('#apply-dialog');
    d.innerHTML = `
      <div class="apply">
        <div class="spinner-orb"></div>
        <h2>Putting ${esc(t.emoji)} ${esc(t.name)} on the ball</h2>
        <p id="apply-step">Getting ready…</p>
        <div class="progress"><div id="apply-bar"></div></div>
      </div>`;
    d.showModal();
    d.oncancel = (e) => e.preventDefault(); // don't let Esc hide a write in progress
    applyUnsub?.();
    applyUnsub = api.on('apply:progress', (p) => {
      const s = STEP_TEXT[p.step];
      $('#apply-step').textContent = typeof s === 'function' ? s(p) : s;
      if (p.step === 'copying') $('#apply-bar').style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
    });
    try {
      const res = await api.applyTheme(id);
      d.oncancel = null;
      d.innerHTML = `
        <div class="apply">
          <div class="spinner-orb done"></div>
          <h2>All set! 🎉</h2>
          <p>${plural(res.count, 'clip')} from ${esc(t.name)} are on the ball.</p>
          ${res.saved ? `<p>The ${plural(res.saved.count, 'video')} that were already on it are kept in “${esc(res.saved.name)}”.</p>` : ''}
          <div class="actions">
            <button class="btn" data-close>Not yet</button>
            <button class="btn primary" id="apply-eject">Eject the ball</button>
          </div>
        </div>`;
      $('[data-close]', d).onclick = () => d.close();
      $('#apply-eject', d).onclick = () => ejectBall(d);
      await reloadThemes();
    } catch (err) {
      d.oncancel = null;
      d.innerHTML = `
        <div class="apply">
          <h2>That didn’t work</h2>
          <p>${esc(err.message)}</p>
          <div class="actions"><button class="btn" data-close>Close</button></div>
        </div>`;
      $('[data-close]', d).onclick = () => d.close();
    } finally {
      applyUnsub?.();
      applyUnsub = null;
    }
  }

  async function ejectBall(dialog = $('#apply-dialog')) {
    if (!dialog.open) dialog.showModal();
    dialog.innerHTML = `<div class="apply"><div class="spinner-orb"></div><h2>Ejecting…</h2></div>`;
    const res = await guard(() => api.eject());
    dialog.innerHTML = res?.ok
      ? `<div class="apply"><div class="spinner-orb done"></div><h2>Ready!</h2>
           <p>Unplug the ball, then hold the middle button to turn it on.</p>
           <div class="actions"><button class="btn primary" data-close>Yay</button></div></div>`
      : `<div class="apply"><h2>Couldn’t eject</h2>
           <p>${esc(res?.error || 'Something is still using the ball.')} Wait a few seconds, then unplug it.</p>
           <div class="actions"><button class="btn" data-close>OK</button></div></div>`;
    $('[data-close]', dialog).onclick = () => dialog.close();
  }

  // ------------------------------------------------------------ boot

  // Files dropped outside the drop zone shouldn't do anything.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  $('#theme-dialog').addEventListener('close', () => {
    openId = null;
  });

  api.on('ball:status', (s) => {
    status = s;
    renderStatus();
  });

  (async () => {
    info = (await guard(() => api.info())) || info;
    status = (await guard(() => api.ballStatus())) || status;
    await guard(reloadThemes);
    const m = /theme=([^&]+)/.exec(location.hash);
    if (m && byId(decodeURIComponent(m[1]))) openTheme(decodeURIComponent(m[1]));
  })();
})();
