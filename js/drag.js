// Glisser-déposer unifié souris / tactile (appui long sur téléphone).

let active = null;

// Empêche le défilement de la page pendant un glissement tactile.
document.addEventListener('touchmove', (e) => { if (active?.started) e.preventDefault(); }, { passive: false });

function suppressNextClick() {
  const h = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', h, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', h, { capture: true }), 60);
}

/**
 * Active le glissement des éléments `selector` contenus dans `root`.
 * onStart(st, event) -> données (false pour annuler) ; onMove(st) ; onEnd(st, cancelled)
 * st : { el, x0, y0, x, y, data, touch }
 */
export function enableDrag(root, { selector, onStart, onMove, onEnd, hold = 280 }) {
  root.addEventListener('contextmenu', (e) => { if (e.target.closest(selector)) e.preventDefault(); });
  root.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    const el = e.target.closest(selector);
    if (!el || !root.contains(el)) return;
    if (e.target.closest('input, select, textarea, a, button:not([data-drag-ok])')) return;
    const touch = e.pointerType !== 'mouse';
    const st = { el, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, touch, data: null, pid: e.pointerId, target: e.target };
    active = st;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging');
      if (active === st) active = null;
    };
    const begin = () => {
      st.started = true;
      st.data = onStart(st, e);
      if (st.data === false) { st.started = false; cleanup(); return; }
      document.body.classList.add('dragging');
      if (touch) navigator.vibrate?.(12);
      onMove?.(st);
    };
    const move = (ev) => {
      if (ev.pointerId !== st.pid) return;
      st.x = ev.clientX; st.y = ev.clientY;
      if (!st.started) {
        const d = Math.hypot(st.x - st.x0, st.y - st.y0);
        if (touch) { if (d > 10) cleanup(); return; }
        if (d < 5) return;
        begin();
        if (!st.started) return;
      }
      ev.preventDefault();
      onMove?.(st);
    };
    const up = (ev) => {
      if (ev.pointerId !== st.pid) return;
      if (st.started) {
        onEnd?.(st, ev.type === 'pointercancel');
        suppressNextClick();
      }
      cleanup();
    };
    if (touch) timer = setTimeout(begin, hold);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/** Étiquette flottante qui suit le doigt / la souris. */
export function makeGhost(html, cls = '') {
  const g = document.createElement('div');
  g.className = `drag-ghost ${cls}`;
  g.innerHTML = html;
  document.body.appendChild(g);
  return {
    move(x, y) { g.style.transform = `translate(${x + 12}px, ${y + 12}px)`; },
    remove() { g.remove(); },
    el: g,
  };
}

/** Élément sous le pointeur correspondant au sélecteur. */
export function dropTarget(x, y, selector) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest(selector) : null;
}

/** Fait défiler un conteneur quand le pointeur approche de ses bords. */
export function autoScroll(container, x, y, margin = 40, speed = 14) {
  if (!container) return;
  const r = container.getBoundingClientRect();
  if (y < r.top + margin) container.scrollTop -= speed;
  else if (y > r.bottom - margin) container.scrollTop += speed;
  if (x < r.left + margin) container.scrollLeft -= speed;
  else if (x > r.right - margin) container.scrollLeft += speed;
}
