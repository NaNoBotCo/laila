// The deck: slide order, the top bar, arrows, swipe.
(function () {
  const SLIDES = ['', 'line/', 'find/', 'maps/', 'robots/', 'talk/', 'rates/', 'books/', 'card/', 'sunk/', 'hello/'];
  const root = document.currentScript.src.replace(/deck\.js.*$/, '');
  const here = location.href.replace(/[?#].*$/, '').replace(/index\.html$/, '');
  let i = SLIDES.findIndex(s => here === root + s);
  if (i < 0) i = 0;
  const prev = i > 0 ? root + SLIDES[i - 1] : null;
  const next = i < SLIDES.length - 1 ? root + SLIDES[i + 1] : null;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML =
    `<a class="brand" href="${root}"><b>♛</b> LAILA</a>` +
    `<span class="n">${i + 1} / ${SLIDES.length}</span>` +
    `<a class="go" href="${prev || '#'}" aria-label="Back" ${prev ? '' : 'aria-disabled="true"'}>‹</a>` +
    `<a class="go" href="${next || '#'}" aria-label="Next" ${next ? '' : 'aria-disabled="true"'}>›</a>`;
  document.body.prepend(bar);
  addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight' && next) location.href = next;
    if (e.key === 'ArrowLeft' && prev) location.href = prev;
  });
  let x0 = null;
  addEventListener('touchstart', e => { if (!e.target.closest('.noswipe')) x0 = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (dx < -80 && next) location.href = next;
    if (dx > 80 && prev) location.href = prev;
  });
})();
