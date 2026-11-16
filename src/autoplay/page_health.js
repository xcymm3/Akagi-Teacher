// Page-local autoplay diagnostics. No IPC, network, pixels or game-state access.
// Inspired by the focus/render diagnostics observed in AkagiMS 1.3.2.
(() => {
  const host = location.hostname;
  if (!['maj-soul.com', 'mahjongsoul.com', 'majsoul.com', 'mahjongsoul.game.yo-star.com']
      .some(root => host === root || host.endsWith('.' + root))) return;
  if (window.__akagiTeacherHealth) return;
  const state = { frames: 0, lastFrame: 0, lost: false, losses: 0, restores: 0,
    focusRepairs: 0, blurs: 0, suppressedBlurs: 0, visibilityChanges: 0,
    pointerDown: 0, mouseDown: 0, mouseUp: 0, armedUntil: 0 };
  let observed = null;
  let press = null, lastPress = null;
  const installedAt = performance.now();
  const canvas = () => document.getElementById('unity-canvas') || document.querySelector('canvas');
  function watchCanvas(c) {
    if (c === observed) return;
    observed = c;
    state.lost = false;
    if (!c) return;
    c.addEventListener('webglcontextlost', () => {
      if (observed === c) { state.lost = true; state.losses++; }
    });
    c.addEventListener('webglcontextrestored', () => {
      if (observed === c) { state.lost = false; state.restores++; }
    });
  }
  function frame() {
    state.frames++;
    state.lastFrame = performance.now();
    watchCanvas(canvas());
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
  window.addEventListener('blur', ev => {
    if (ev.target !== window && ev.target !== document) return;
    state.blurs++;
    // Suppress only during an autoplay press, never permanently or on IME inputs.
    if (Date.now() < state.armedUntil) {
      state.suppressedBlurs++;
      ev.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('visibilitychange', () => state.visibilityChanges++);
  for (const [event, key] of [['pointerdown', 'pointerDown'], ['mousedown', 'mouseDown'], ['mouseup', 'mouseUp']]) {
    window.addEventListener(event, ev => {
      const c = canvas();
      if (c && ev.target === c) state[key]++;
    }, true);
  }
  function snapshot() {
    const c = canvas();
    watchCanvas(c);
    const rect = c ? c.getBoundingClientRect() : null;
    return { supported: true, focused: document.hasFocus(), hidden: document.hidden,
      canvas: !!c, width: rect ? rect.width : 0, height: rect ? rect.height : 0,
      contextLost: state.lost, frames: state.frames,
      frameAgeMs: Math.max(0, performance.now() - (state.lastFrame || installedAt)),
      lastPress,
      focusRepairs: state.focusRepairs, blurs: state.blurs, suppressedBlurs: state.suppressedBlurs,
      losses: state.losses, restores: state.restores, visibilityChanges: state.visibilityChanges,
      pointerDown: state.pointerDown, mouseDown: state.mouseDown, mouseUp: state.mouseUp };
  }
  window.__akagiTeacherHealth = Object.freeze({
    snapshot,
    prepare(ms) {
      press = { at: performance.now(), frames: state.frames, pointerDown: state.pointerDown,
        mouseDown: state.mouseDown, mouseUp: state.mouseUp, focusRepairs: state.focusRepairs };
      state.armedUntil = Date.now() + Math.min(5000, Math.max(0, Number(ms) || 0));
      if (!document.hidden && !document.hasFocus()) {
        state.focusRepairs++;
        window.dispatchEvent(new Event('focus'));
      }
      return snapshot();
    },
    finish() {
      state.armedUntil = 0;
      if (press) {
        lastPress = { elapsedMs: Math.max(0, performance.now() - press.at),
          framesAdvanced: state.frames - press.frames,
          pointerDown: state.pointerDown - press.pointerDown,
          mouseDown: state.mouseDown - press.mouseDown, mouseUp: state.mouseUp - press.mouseUp,
          focusRepaired: state.focusRepairs > press.focusRepairs };
        press = null;
      }
      return snapshot();
    }
  });
})();
