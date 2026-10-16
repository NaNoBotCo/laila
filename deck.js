// The deck: slide order, the top bar, arrows, swipe, the presenter's lines, the one ask.
(function () {
  const LINE_ASK = 'https://line.me/R/oaMessage/%40964yxgnk/?' +
    encodeURIComponent('สวัสดีค่ะ อยากลองธุรกิจแรกค่ะ · Hi, I would like to try one business.');
  // One line per slide for whoever presents: what to say (English, Thai) and what to tap.
  const SAY = [
    ['', 'Laila, you run twenty businesses. We can put all of them in your LINE.', 'คุณไลลามีธุรกิจยี่สิบอย่าง เราทำให้ดูทุกอย่างได้ในไลน์เดียวค่ะ', 'Tap Start.'],
    ['line/', 'Every morning at eight: one message. Money in, money out, what needs you.', 'ทุกเช้าแปดโมง ข้อความเดียว เงินเข้า เงินออก เรื่องที่ต้องตัดสินใจ', 'Tap “2 bills to approve”, then ✕ on the ad agency.'],
    ['find/', 'Google Maps cannot find your exchange. Mot Dang puts you first.', 'กูเกิลแมพหาร้านแลกเงินไม่เจอ แต่มดแดงขึ้นอันดับแรก', 'Tap “visa”.'],
    ['maps/', 'We fill in Google for you. You record one short video at the door.', 'เรากรอกข้อมูลกูเกิลให้หมด คุณไลลาถ่ายวิดีโอสั้นๆ ที่หน้าร้านแค่ครั้งเดียว', 'Drag a pin.'],
    ['robots/', 'This is what Google’s robot reads. We write it so Google understands you.', 'นี่คือสิ่งที่หุ่นยนต์กูเกิลอ่าน เราเขียนให้กูเกิลเข้าใจร้าน', 'Tap 🤖 Google.'],
    ['talk/', 'Every customer, in their own language.', 'ลูกค้าทุกคน คุยภาษาของเขาได้', 'Pick 中文, then 🔊.'],
    ['rates/', 'Change the rate once. It shows everywhere.', 'เปลี่ยนเรทครั้งเดียว ขึ้นทุกที่', 'Point at the board.'],
    ['books/', 'All the books in one place, Thai tax included.', 'บัญชีทุกธุรกิจอยู่ที่เดียว ภาษีไทยครบ', 'Wait for it to load, then tap Inbox.'],
    ['card/', 'Every page gets a card for LINE and a QR code for the door.', 'ทุกหน้ามีการ์ดสำหรับไลน์ และคิวอาร์ติดหน้าร้าน', 'Tap Visa.'],
    ['sunk/', 'Money already spent is gone either way. Only what comes next is a choice.', 'เงินที่จ่ายไปแล้วหายไปทั้งสองทาง ตัดสินใจจากเงินที่จะจ่ายต่อจากนี้', 'Slide “Already paid”. The answer stays.'],
    ['hello/', 'Can we start with one business today? Send one sheet on LINE. Tomorrow at eight, it is on your phone.', 'เริ่มธุรกิจแรกวันนี้เลยได้ไหมคะ ส่งชีทมาหนึ่งชีททางไลน์ พรุ่งนี้แปดโมงขึ้นในมือถือเลยค่ะ', 'Hand her the phone. Ask. Then stop and wait.']
  ];
  window.LAILA = { SAY, LINE_ASK };
  const me = document.currentScript;
  if (me.dataset.noslide !== undefined) return;

  const SLIDES = SAY.map(s => s[0]);
  const root = me.src.replace(/deck\.js.*$/, '');
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
    `<button class="go mic" aria-label="Presenter lines" title="Presenter lines">🎤</button>` +
    `<a class="go" href="${prev || '#'}" aria-label="Back" ${prev ? '' : 'aria-disabled="true"'}>‹</a>` +
    `<a class="go" href="${next || '#'}" aria-label="Next" ${next ? '' : 'aria-disabled="true"'}>›</a>`;
  document.body.prepend(bar);

  // The one ask, on every slide but the last.
  if (next) {
    const cta = document.createElement('a');
    cta.className = 'cta';
    cta.href = root + 'hello/';
    cta.innerHTML = 'Start with one business <b>›</b>';
    document.body.appendChild(cta);
  }

  // Presenter lines: 🎤, the P key, or ?say in the address.
  const s = SAY[i];
  const strip = document.createElement('div');
  strip.className = 'say';
  strip.innerHTML = `<div class="say-en">${s[1]}</div><div class="say-th" lang="th">${s[2]}</div><div class="say-tap">👆 ${s[3]}</div><a class="say-all" href="${root}say/">All lines + answers</a>`;
  document.body.appendChild(strip);
  let on = /[?&]say\b/.test(location.search);
  try { on = on || localStorage.getItem('laila-say') === '1'; } catch (e) {}
  const set = v => { on = v; document.body.classList.toggle('saying', v); try { localStorage.setItem('laila-say', v ? '1' : '0'); } catch (e) {} };
  set(on);
  bar.querySelector('.mic').onclick = () => set(!on);

  addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight' && next) location.href = next;
    if (e.key === 'ArrowLeft' && prev) location.href = prev;
    if (e.key === 'p' || e.key === 'P') set(!on);
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
