'use strict';

// Plays a theme the way the ball shows it: every clip in order, looping, with sound.
// The window's hash says which theme: #theme=builtin/halloween

(() => {
  const api = window.ballApi;
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  let clips = [];
  let name = '';
  let index = 0;

  const MUTE_KEY = 'preview-muted';
  const loadMuted = () => {
    try {
      return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  };
  const saveMuted = (m) => {
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* private storage unavailable: fine, it just won't be remembered */
    }
  };

  function show(i) {
    if (!clips.length) return;
    index = (i + clips.length) % clips.length;
    video.src = clips[index].url;
    video.play().catch(() => {});
    $('label').textContent = `${name} · ${clips[index].title} (${index + 1} of ${clips.length})`;
  }

  function setMuted(m) {
    video.muted = m;
    $('mute').textContent = m ? '🔇' : '🔊';
    $('mute').setAttribute('aria-label', m ? 'Unmute' : 'Mute');
    saveMuted(m);
  }

  function syncPlay() {
    const playing = !video.paused;
    $('play').textContent = playing ? '❚❚' : '▶︎';
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  async function load(themeId) {
    const theme = await api.getTheme(themeId);
    clips = theme.clips;
    name = `${theme.emoji} ${theme.name}`;
    document.title = `${theme.name} preview`;
    if (!clips.length) {
      $('label').textContent = `${name} has no clips yet`;
      return;
    }
    show(0);
  }

  video.addEventListener('ended', () => show(index + 1));
  video.addEventListener('play', syncPlay);
  video.addEventListener('pause', syncPlay);
  $('prev').onclick = () => show(index - 1);
  $('next').onclick = () => show(index + 1);
  $('play').onclick = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  $('mute').onclick = () => setMuted(!video.muted);
  $('close').onclick = () => window.close();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === ' ') $('play').click();
    else if (e.key === 'Escape') window.close();
    else return;
    e.preventDefault();
  });

  // The main window asks for a different theme without reopening this one.
  api.on('preview:show', (themeId) => load(themeId));

  setMuted(loadMuted());
  const m = /theme=([^&]+)/.exec(location.hash);
  if (m) load(decodeURIComponent(m[1]));
})();
