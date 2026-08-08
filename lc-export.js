/* ============================================================================
 * Export your lubimyczytac.pl library to CSV from the console
 * ----------------------------------------------------------------------------
 * Talks to the site's own pagination endpoint:
 *     POST /profile/getLibraryBooksList   (X-Requested-With header required)
 *     -> {"code":"OK","data":{"content":"<html…>"}}
 *
 * HOW TO USE
 *   1. Log in, open https://lubimyczytac.pl/biblioteczka in LIST view.
 *   2. F12 -> Console. Type "allow pasting" if asked.
 *   3. Paste this file, Enter.
 *   4. CSV downloads when it finishes.
 *
 * By default it exports the "Przeczytane" shelf only, using nothing but the
 * library list pages - no per-book requests, so nothing to rate-limit.
 * ========================================================================== */

(async () => {
  'use strict';

  const CONFIG = {
    // --- what to export -----------------------------------------------------
    // 'all'   : every shelf on the page          (['all'] works too)
    // 'auto'  : whatever is ticked in the sidebar (['auto'] works too)
    // list    : shelf names or numeric ids, e.g.
    //           ['Przeczytane'] or ['Przeczytane', 'Teraz czytam'] or ['1234567']
    shelves:         ['Przeczytane'],

    includeRating:   true,
    includeReview:   true,
    goodreadsFormat: false,  // rescale ratings to 1-5, translate shelf names,
                             // normalise dates to YYYY/MM/DD

    // --- optional per-book detail lookup ------------------------------------
    // OFF by default. Turning this on issues one request per book to fill in
    // ISBN, publisher and publication years.
    fetchBookPages:  false,
    bookConcurrency: 1,
    bookDelayMs:     2000,

    // --- output -------------------------------------------------------------
    includeFormat:    false, // true = add a Binding column marking audiobooks
    dropEmptyColumns: false, // true = omit columns that are blank for every book
    addBOM:           false, // true is friendlier to Excel, but can upset
                             // Goodreads' column detection
    debug:            true,  // print fill rates + keep a sample row
    filename:         'lubimyczytac_export.csv',

    // --- pacing and retries -------------------------------------------------
    listDelayMs:     2000,               // pause between library list pages
    retryWaitsMs:    [5000, 15000, 30000],  // 3 retries, increasing backoff
    maxPages:        200,

  };

  const ENDPOINT = '/profile/getLibraryBooksList';
  const PAGE_SIZE_HINT = 20;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log   = (...a) => console.log('%c[lc-export]', 'color:#0a7', ...a);
  const warn  = (...a) => console.warn('[lc-export]', ...a);
  const txt   = el => el ? (el.textContent || '').replace(/\u00a0/g, ' ').trim() : '';
  const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

  if (location.hostname !== 'lubimyczytac.pl') throw new Error('Run this on lubimyczytac.pl');

  // Grows whenever the server pushes back, so a slow start does not become a
  // hammering finish.
  const state = { extraDelay: 0 };

  async function request(url, opts, label) {
    const waits = CONFIG.retryWaitsMs;
    for (let attempt = 0; ; attempt++) {
      if (state.extraDelay) await sleep(state.extraDelay);
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        if (attempt >= waits.length) throw new Error(`${label}: ${e.message}`);
        warn(`${label}: network error - retry ${attempt + 1}/${waits.length} in ${waits[attempt] / 1000}s`);
        await sleep(waits[attempt]);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        state.extraDelay = Math.min(state.extraDelay + 500, 5000);
        if (attempt >= waits.length) throw new Error(`${label}: HTTP ${res.status} after ${waits.length} retries`);
        const ra = parseInt(res.headers.get('Retry-After') || '', 10);
        const wait = Number.isFinite(ra) ? Math.min(ra * 1000, 60000) : waits[attempt];
        warn(`${label}: HTTP ${res.status} (throttled) - waiting ${Math.round(wait / 1000)}s ` +
             `[all later requests slowed by ${state.extraDelay}ms]`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      return res;
    }
  }

  // ------------------------------------------------------------ shelf picker
  function discoverShelves() {
    return Array.from(document.querySelectorAll('input[name="shelfs[]"]'))
      .map(i => ({
        id: i.value,
        name: (i.getAttribute('data-shelf-name') || '').trim(),
        checked: i.checked,
      }))
      .filter(s => s.id);
  }

  function resolveShelves() {
    const found = discoverShelves();
    if (found.length) {
      log('shelves on this page: ' +
          found.map(s => `${s.name} (${s.id})${s.checked ? ' [ticked]' : ''}`).join(', '));
    } else {
      warn('no shelf checkboxes found on this page - exporting the library in one pass');
    }

    // Accept both 'all' and ['all'], 'auto' and ['auto'], so the option behaves
    // the same whether or not it is written as a list.
    const keys = (Array.isArray(CONFIG.shelves) ? CONFIG.shelves : [CONFIG.shelves])
      .map(w => String(w ?? '').trim()).filter(Boolean);

    if (keys.some(k => k.toLowerCase() === 'all')) return found;

    if (keys.some(k => k.toLowerCase() === 'auto')) {
      const ticked = found.filter(s => s.checked);
      if (ticked.length) return ticked;
      const fromUrl = new URLSearchParams(location.search).getAll('shelfs[]');
      if (fromUrl.length) {
        return fromUrl.map(id => found.find(s => s.id === id) || { id, name: '' });
      }
      return found;
    }

    const out = [];
    for (const want of keys) {
      const k = want.toLowerCase();
      const hit = found.find(s => s.id === want || s.name.toLowerCase() === k);
      if (hit) out.push(hit);
      else if (/^\d+$/.test(want)) out.push({ id: want, name: '' });
      else warn(`shelf "${want}" not found. Available: ` +
                (found.map(s => `"${s.name}"`).join(', ') || 'none') +
                ` - or use 'all'.`);
    }
    return out;
  }

  const shelves = resolveShelves();
  if (!shelves.length) {
    warn('no shelf selected - exporting the whole library in one pass');
  } else {
    log('exporting: ' + shelves.map(s => s.name || s.id).join(', '));
  }

  // ---------------------------------------------------------- request bodies
  // Array params go out as shelfs[] exactly as the site sends them. Indexing
  // them (shelfs[0]) makes the server ignore the filter and return everything.
  function buildBody(page, shelfId) {
    const src = new URLSearchParams(location.search);
    const out = new URLSearchParams();
    for (const [k, v] of src) {
      if (k === 'page' || k === '_req') continue;
      if (/^shelfs(\[\d*\])?$/.test(k)) continue;      // we set these ourselves
      out.append(k, v);
    }
    if (!out.has('objectId')) {
      const oid = findObjectId();
      if (oid) out.set('objectId', oid);
    }
    if (!out.has('own'))           out.set('own', '1');
    if (!out.has('listId'))        out.set('listId', 'booksFilteredList');
    if (!out.has('listType'))      out.set('listType', 'list');
    if (!out.has('paginatorType')) out.set('paginatorType', 'Standard');
    if (!out.has('findString'))    out.set('findString', '');
    if (!out.has('kolejnosc'))     out.set('kolejnosc', 'data-dodania');
    out.set('page', String(page));
    if (shelfId) out.append('shelfs[]', shelfId);
    return out.toString();
  }

  function findObjectId() {
    const fromUrl = new URLSearchParams(location.search).get('objectId');
    if (fromUrl) return fromUrl;
    const vp = document.querySelector('[data-viewparams*="accountId="]');
    const m1 = vp?.getAttribute('data-viewparams').match(/accountId=(\d+)/);
    if (m1) return m1[1];
    const m2 = document.querySelector('a[href*="/profil/"]')?.getAttribute('href').match(/\/profil\/(\d+)/);
    return m2 ? m2[1] : null;
  }

  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  const HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',            // required - without it: 404
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  };

  function extractHTML(payload) {
    let best = '';
    (function walk(node, depth) {
      if (depth > 6 || node == null) return;
      if (typeof node === 'string') {
        if (/<\w[\s\S]*>/.test(node) && node.length > best.length) best = node;
      } else if (typeof node === 'object') {
        for (const v of Object.values(node)) walk(v, depth + 1);
      }
    })(payload, 0);
    return best;
  }

  async function fetchListPage(page, shelfId, label) {
    const res = await request(ENDPOINT, {
      method: 'POST', credentials: 'same-origin', headers: HEADERS,
      body: buildBody(page, shelfId),
    }, label);
    const raw = await res.text();
    let html;
    try {
      const json = JSON.parse(raw);
      if (json.code && json.code !== 'OK') throw new Error('API returned ' + json.code);
      html = extractHTML(json);
    } catch (e) {
      if (/^\s*[{[]/.test(raw)) throw e;
      html = raw;
    }
    if (!html) throw new Error(label + ': no HTML in response');
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // ------------------------------------------------------------- extraction
  const ROW = '.book-card, [id^="listBookElement"]';

  // A work page can be /ksiazka/<id>/…, /audiobook/<id>/… or /ebook/<id>/…,
  // so never key off one of those segments. The cover is a <form>, not a link,
  // which leaves a.book-card__title as the only anchor to the work itself.
  const WORK_RX = /\/(?:ksiazka|audiobook|ebook)\/\d+/;

  function pickTitle(card, author) {
    const el = card.querySelector('a.book-card__title, [class*="book-card__title"]');
    if (el) {
      const t = oneLine(el.getAttribute('title')) || oneLine(el.textContent);
      if (t) return { text: t, href: el.getAttribute('href') || '' };
    }
    const a = Array.from(card.querySelectorAll('a[href]'))
      .find(x => WORK_RX.test(x.getAttribute('href') || ''));
    if (a) {
      return { text: oneLine(a.getAttribute('title')) || oneLine(a.textContent),
               href: a.getAttribute('href') || '' };
    }
    // Last resort: the cover form knows the URL, and its alt text carries
    // "Okładka książki <title> <author>".
    const form = card.querySelector('form[action]');
    const href = WORK_RX.test(form?.getAttribute('action') || '')
      ? form.getAttribute('action') : '';
    let text = oneLine(card.querySelector('img[alt]')?.getAttribute('alt') || '')
      .replace(/^Okładka\s+(?:książki|audiobooka|ebooka)\s*/i, '');
    if (author && text.endsWith(author)) text = text.slice(0, -author.length).trim();
    return { text, href };
  }

  function parseCard(card, shelfName) {
    const id = card.getAttribute('data-book-id') || (card.id.match(/(\d+)/) || [])[1] || '';

    const author = Array.from(new Set(
      Array.from(card.querySelectorAll('a[href*="/autor/"]'))
        .map(a => oneLine(a.textContent)).filter(Boolean))).join(', ');

    const picked = pickTitle(card, author);
    const titleText = picked.text;
    let url = '';
    if (picked.href) { try { url = new URL(picked.href, location.origin).href; } catch {} }

    let myRating = '';
    if (CONFIG.includeRating) {
      const box = card.querySelector('[class*="my-rating"]');
      if (box) {
        myRating = txt(box.querySelector('.rating__avarage, .rating__average'))
                || (txt(box).match(/\b(10|[0-9])\b/) || [])[1] || '';
      }
    }

    // Site average sits in its own detail block, rendered as "6,4 z 83 ocen".
    let avgRating = '';
    const avgBox = card.querySelector('.book-card__detail--rating');
    if (avgBox) avgRating = txt(avgBox.querySelector('.rating__avarage, .rating__average'));
    if (!avgRating) {
      const m = txt(card).match(/(\d+[.,]\d+)\s*z\s*[\d ]+\s*ocen/i);
      if (m) avgRating = m[1];
      else {
        avgRating = txt(Array.from(card.querySelectorAll('.rating__avarage, .rating__average'))
          .filter(el => !el.closest('[class*="my-rating"]'))[0]);
      }
    }

    let dateRead = '';
    const dateBox = card.querySelector('.book-card__read-dates, [class*="read-date"]');
    if (dateBox) {
      const d = txt(dateBox).match(/\d{4}(?:-\d{2}(?:-\d{2})?)?/);
      dateRead = d ? d[0] : '';
    }

    // Review: the text sits in a <p class="expandTextNoJS"> inside
    // .book-card__review, wrapped in comment scaffolding we do not want.
    // Cards carrying one are also tagged .book-card--with-review.
    let myReview = '';
    if (CONFIG.includeReview) {
      const paras = Array.from(card.querySelectorAll('.book-card__review p.expandTextNoJS'));
      const best = paras.map(txt).sort((a, b) => b.length - a.length)[0] || '';
      myReview = best.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
                     .replace(/\n{3,}/g, '\n\n').trim();
    }

    // The row lists every shelf a book sits on ("Masz na półce: Przeczytane"),
    // which beats assuming the shelf we happen to be querying.
    const rowShelves = Array.from(card.querySelectorAll('.book-card__shelf'))
      .map(a => oneLine(a.getAttribute('title')) || oneLine(a.textContent))
      .filter(Boolean);
    const shelves = rowShelves.length
      ? Array.from(new Set(rowShelves)).join(', ')
      : (shelfName || '');

    const format = /\/audiobook\/\d+/.test(url) ? 'audiobook'
                 : /\/ebook\/\d+/.test(url)     ? 'ebook' : 'book';

    return { id, title: titleText, author, myRating, avgRating, dateRead,
             shelves, myReview, url, format,
             isbn: '', publisher: '', yearPub: '', yearOrig: '' };
  }

  // -------------------------------------------------------------- collect
  const byId = new Map();
  let sampleCard = null;

  async function collectShelf(shelf) {
    const label = shelf ? `shelf "${shelf.name || shelf.id}"` : 'library';
    let addedTotal = 0;

    for (let page = 1; page <= CONFIG.maxPages; page++) {
      let doc;
      try {
        doc = await fetchListPage(page, shelf?.id, `${label} page ${page}`);
      } catch (e) {
        warn(`${label}: stopping at page ${page} - ${e.message}`);
        break;
      }

      const cards = Array.from(doc.querySelectorAll(ROW));
      if (!cards.length) { log(`${label} page ${page}: empty - done`); break; }
      if (!sampleCard) sampleCard = cards[0].outerHTML;

      let added = 0;
      for (const card of cards) {
        const book = parseCard(card, shelf?.name);
        const key = book.id || (book.title + '|' + book.author);
        const existing = byId.get(key);
        if (existing) {
          // Same book on a second shelf - merge the shelf names.
          const names = new Set(
            (existing.shelves + ',' + book.shelves).split(',').map(s => s.trim()).filter(Boolean));
          existing.shelves = Array.from(names).join(', ');
        } else {
          byId.set(key, book);
          added++; addedTotal++;
        }
      }
      log(`${label} page ${page}: ${cards.length} rows, +${added} new (total ${byId.size})`);
      if (cards.length < PAGE_SIZE_HINT) { log(`${label}: short page - last one`); break; }
      await sleep(CONFIG.listDelayMs);
    }
    return addedTotal;
  }

  if (shelves.length) { for (const s of shelves) await collectShelf(s); }
  else await collectShelf(null);

  const all = Array.from(byId.values());
  if (!all.length) throw new Error('No books collected - check that you are on the library page.');
  window.__lcBooks = all;

  // --------------------------------------------------- optional book pages
  if (CONFIG.fetchBookPages) {
    const targets = all.filter(b => b.url);
    log(`fetching detail pages for ${targets.length} books ` +
        `(concurrency ${CONFIG.bookConcurrency}, ${CONFIG.bookDelayMs}ms apart). ` +
        `Rough estimate: ${Math.ceil(targets.length * CONFIG.bookDelayMs / CONFIG.bookConcurrency / 60000)} min.`);

    let done = 0, cursor = 0;
    await Promise.all(Array.from({ length: CONFIG.bookConcurrency }, async () => {
      while (cursor < targets.length) {
        const book = targets[cursor++];
        try {
          const res = await request(book.url, { credentials: 'same-origin' }, 'book page');
          const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

          book.isbn = doc.querySelector('meta[property="books:isbn"]')?.content
                   || doc.querySelector('meta[name="isbn"]')?.content || '';

          const dl = doc.querySelector('#book-details dl') || doc.querySelector('#book-details');
          if (dl) {
            for (const dt of dl.querySelectorAll('dt')) {
              const label = txt(dt), value = txt(dt.nextElementSibling);
              if (!book.isbn && /^\s*ISBN/i.test(label))        book.isbn = value.replace(/[^0-9Xx]/g, '');
              else if (/^\s*Data\s+wydania/i.test(label))       book.yearPub  = (value.match(/\d{4}/) || [''])[0];
              else if (/^\s*Data\s+1\.\s*wyd/i.test(label))     book.yearOrig = (value.match(/\d{4}/) || [''])[0];
            }
          }
          const pub = doc.querySelector('a[href*="/wydawnictwo/"]');
          if (pub) book.publisher = oneLine(pub.textContent);
        } catch (e) {
          warn(`skipping details for "${book.title}": ${e.message}`);
        }
        if (++done % 25 === 0 || done === targets.length) log(`details ${done}/${targets.length}`);
        await sleep(CONFIG.bookDelayMs);
      }
    }));
  }

  // ------------------------------------------------------------------- CSV
  const COLUMNS = [
    ['Title',                     b => b.title],
    ['Author',                    b => b.author],
    ['ISBN',                      b => b.isbn],
    ['My Rating',                 b => b.myRating],
    ['Average Rating',            b => b.avgRating],
    ['Publisher',                 b => b.publisher],
    ['Year Published',            b => b.yearPub],
    ['Original Publication Year', b => b.yearOrig],
    ['Date Read',                 b => b.dateRead],
    ['Shelves',                   b => b.shelves],
    ['My Review',                 b => b.myReview],
  ];
  // Now that audiobooks are identifiable from the URL, this is free data.
  if (CONFIG.includeFormat) COLUMNS.splice(6, 0, ['Binding', b => b.format]);

  const SHELF_MAP = { 'przeczytane': 'read', 'teraz czytam': 'currently-reading',
                      'czytam teraz': 'currently-reading', 'chcę przeczytać': 'to-read' };

  function toGoodreads(b) {
    const o = { ...b };
    const r = parseInt(b.myRating, 10);
    if (Number.isFinite(r) && r > 0) o.myRating = String(Math.ceil(r / 2));
    const a = parseFloat(String(b.avgRating).replace(',', '.'));
    if (Number.isFinite(a)) o.avgRating = (a / 2).toFixed(2);
    if (/^\d{4}$/.test(b.dateRead))                  o.dateRead = b.dateRead + '/01/01';
    else if (/^\d{4}-\d{2}$/.test(b.dateRead))       o.dateRead = b.dateRead.replace('-', '/') + '/01';
    else if (/^\d{4}-\d{2}-\d{2}$/.test(b.dateRead)) o.dateRead = b.dateRead.replace(/-/g, '/');
    o.shelves = String(b.shelves).split(',').map(s => s.trim()).filter(Boolean)
      .map(s => SHELF_MAP[s.toLowerCase()] ?? s.replace(/ /g, '-')).join(', ');
    return o;
  }

  const escapeCSV = v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const rows = CONFIG.goodreadsFormat ? all.map(toGoodreads) : all;
  const cols = CONFIG.dropEmptyColumns
    ? COLUMNS.filter(([, get]) => rows.some(b => String(get(b) ?? '').trim()))
    : COLUMNS;
  if (cols.length !== COLUMNS.length) {
    log('dropped empty columns: ' +
        COLUMNS.filter(c => !cols.includes(c)).map(([h]) => h).join(', '));
  }

  const csv = [cols.map(([h]) => h).join(',')]
    .concat(rows.map(b => cols.map(([, get]) => escapeCSV(get(b))).join(',')))
    .join('\r\n') + '\r\n';
  window.__lcCSV = csv;

  // ------------------------------------------------------------ diagnostics
  if (CONFIG.debug) {
    const fields = ['title', 'author', 'myRating', 'avgRating', 'dateRead',
                    'shelves', 'myReview', 'isbn', 'publisher', 'yearPub'];
    console.log('%c[lc-export] field fill rates', 'color:#0a7;font-weight:bold');
    console.table(fields.map(f => ({
      field: f, filled: all.filter(b => String(b[f] ?? '').trim()).length, of: all.length,
    })));
    window.__lcSampleCard = sampleCard;
    log('first row HTML kept in window.__lcSampleCard');
  }
  console.table(rows.slice(0, 10).map(({ url, id, myReview, ...r }) => r));

  // --------------------------------------------------------------- download
  const blob = new Blob([CONFIG.addBOM ? '\ufeff' + csv : csv], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href, download: CONFIG.filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);

  const untitled = all.filter(b => !String(b.title).trim());
  if (untitled.length) {
    warn(`${untitled.length} book(s) came out with no title - their ids: ` +
         untitled.map(b => b.id).join(', '));
    warn('run copy(__lcSampleCard) after inspecting one of those rows so the ' +
         'selector can be widened');
  }

  const reviewed = all.filter(b => b.myReview).length;
  const audio = all.filter(b => b.format === 'audiobook').length;
  log(`done: ${rows.length} books (${reviewed} with a review, ${audio} audiobooks)`);
})().catch(e => console.error('[lc-export] failed:', e));
