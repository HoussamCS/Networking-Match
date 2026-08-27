require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { put, get, list, del } = require('@vercel/blob');
const { Readable } = require('stream');
const QRCode = require('qrcode');
const { randomUUID } = require('crypto');
const { sql, ready } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changez-moi';
const PID_COOKIE = 'pid';
const PID_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days, comfortably covers the event

const CATEGORIES = [
  { value: 'entrepreneur', label: 'Entrepreneur' },
  { value: 'investisseur', label: 'Investisseur' },
  { value: 'associe', label: 'Associé' },
  { value: 'autre', label: 'Autre' },
];
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

// Photos are received in memory then pushed to Vercel Blob — there is no
// writable local disk to keep them on in a serverless function.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

function uploadPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      return res.status(400).render('register', {
        categories: CATEGORIES,
        error: "La photo n'a pas pu être envoyée (fichier trop lourd, 5 Mo max). Réessayez.",
        next: req.body.next || '',
      });
    }
    next();
  });
}

// Wraps an async route handler so rejected promises reach Express's error
// handling instead of crashing the function unhandled.
function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Never let the browser or an edge cache serve a stale copy of a dynamic
// page — this app changes fast during setup and stale HTML/JS causes very
// confusing bugs (old scan.ejs logic silently still running, etc).
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(
  ah(async (req, res, next) => {
    await ready();
    next();
  })
);

// Combines the country-code <select> with the local number typed at
// registration into one full international number (e.g. "+212612345678").
// This is why waLink() below never has to guess a country.
function combinePhone(indicatif, localNumber) {
  const local = (localNumber || '').trim();
  if (!local) return '';

  if (indicatif === 'other' || !indicatif) {
    // "Autre" — trust whatever the person typed, they were asked for +indicatif.
    return local;
  }

  const digits = local.replace(/\D/g, '').replace(/^0+/, '');
  return digits ? `+${indicatif}${digits}` : '';
}

// Builds a wa.me link from a saved phone number. The number is always
// stored in full international format (see combinePhone), so this just
// strips formatting characters — no country guessing needed.
function waLink(telephone) {
  if (!telephone) return null;
  const digits = telephone.replace(/[^0-9]/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

function baseUrl(req) {
  if (process.env.BASE_URL) {
    try {
      return new URL(process.env.BASE_URL).origin;
    } catch {
      // malformed BASE_URL (e.g. missing https://) — fall back below
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

async function getPerson(id) {
  if (!id) return undefined;
  const rows = await sql`SELECT * FROM people WHERE id = ${id}`;
  return rows[0];
}

// The person tied to this browser/device, or undefined if it hasn't
// registered yet (or its cookie is stale, e.g. after a database reset).
async function getMe(req) {
  return getPerson(req.cookies[PID_COOKIE]);
}

function requireMe(req, res, next) {
  getMe(req).then((me) => {
    if (!me) {
      const next_ = req.originalUrl;
      return res.redirect(`/register?next=${encodeURIComponent(next_)}`);
    }
    req.me = me;
    next();
  }, next);
}

async function categoryCounts(excludeId) {
  const rows = await sql`
    SELECT categorie, COUNT(*)::int AS n
    FROM people
    WHERE id != ${excludeId || ''}
    GROUP BY categorie
  `;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.value, 0]));
  rows.forEach((r) => {
    counts[r.categorie] = r.n;
  });
  return counts;
}

// People matched with `personId`, in either direction, most recent first.
async function getMatches(personId) {
  const rows = await sql`
    SELECT p.*, m.created_at AS matched_at
    FROM matches m
    JOIN people p ON p.id = (
      CASE WHEN m.person_id = ${personId} THEN m.matched_person_id ELSE m.person_id END
    )
    WHERE m.person_id = ${personId} OR m.matched_person_id = ${personId}
    ORDER BY m.created_at DESC
  `;
  return rows;
}

async function alreadyConnected(personId, otherId) {
  const rows = await sql`
    SELECT 1 FROM matches
    WHERE (person_id = ${personId} AND matched_person_id = ${otherId})
       OR (person_id = ${otherId} AND matched_person_id = ${personId})
    LIMIT 1
  `;
  return rows.length > 0;
}

// ---- Routes ----

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/register', (req, res) => {
  res.render('register', { categories: CATEGORIES, error: null, next: req.query.next || '' });
});

// Serves private Blob photos: the stored pathname isn't fetchable directly by
// the browser, so we fetch it here with the Blob token and stream it back.
app.get(
  '/photo',
  ah(async (req, res) => {
    const pathname = req.query.pathname;
    if (!pathname) return res.status(400).end();

    const result = await get(pathname, { access: 'private' });
    if (result === null) return res.status(404).end();

    res.setHeader('Content-Type', result.blob.contentType);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(result.stream).pipe(res);
  })
);

app.post(
  '/register',
  uploadPhoto,
  ah(async (req, res) => {
    const { nom, occupation, categorie, email, telephone, indicatif, next } = req.body;

    if (!nom || !nom.trim() || !CATEGORY_LABELS[categorie]) {
      return res.status(400).render('register', {
        categories: CATEGORIES,
        error: 'Merci de renseigner au moins votre nom et votre catégorie.',
        next: next || '',
      });
    }

    let photo = null;
    if (req.file) {
      const ext = EXT_BY_MIME[req.file.mimetype] || '';
      const blob = await put(`photos/${randomUUID()}${ext}`, req.file.buffer, {
        access: 'private',
        contentType: req.file.mimetype,
      });
      photo = blob.pathname;
    }

    const id = randomUUID();
    const fullPhone = combinePhone(indicatif, telephone);
    await sql`
      INSERT INTO people (id, nom, occupation, categorie, email, telephone, photo)
      VALUES (${id}, ${nom.trim()}, ${(occupation || '').trim()}, ${categorie}, ${(email || '').trim()}, ${fullPhone}, ${photo})
    `;

    res.cookie(PID_COOKIE, id, { maxAge: PID_MAX_AGE, httpOnly: true, sameSite: 'lax' });

    // If registration was triggered by scanning someone's QR before having
    // an account, send them straight into that connection afterwards.
    const safeNext = next && next.startsWith('/connect/') ? next : '/profile';
    res.redirect(safeNext);
  })
);

// My own profile — always the device that owns this browser's cookie, never
// whichever id happens to be in the URL.
app.get(
  '/profile',
  requireMe,
  ah(async (req, res) => {
    const person = req.me;
    const connectUrl = `${baseUrl(req)}/connect/${person.id}`;
    const qrDataUrl = await QRCode.toDataURL(connectUrl, { margin: 1, width: 320 });

    res.render('profile', {
      person,
      qrDataUrl,
      categoryLabel: CATEGORY_LABELS[person.categorie],
    });
  })
);

// Camera scanner page — decodes someone's QR client-side then follows the
// /connect/:id link it encodes.
app.get('/scan', requireMe, (req, res) => {
  res.render('scan');
});

// What a personal QR code points to: scanning it connects the scanner (me,
// from the cookie) with the scanned person (:id), regardless of who
// physically holds the phone doing the scanning.
app.get(
  '/connect/:id',
  requireMe,
  ah(async (req, res) => {
    const me = req.me;
    const target = await getPerson(req.params.id);

    if (!target) {
      return res.status(404).render('connect', { self: true, target: null, me });
    }

    if (target.id === me.id) {
      return res.render('connect', { self: true, target: null, me });
    }

    if (!(await alreadyConnected(me.id, target.id))) {
      await sql`INSERT INTO matches (person_id, matched_person_id) VALUES (${me.id}, ${target.id})`;
    }

    res.render('connect', { self: false, target, me, categoryLabel: CATEGORY_LABELS[target.categorie], waLink });
  })
);

app.get(
  '/matches',
  requireMe,
  ah(async (req, res) => {
    const matches = await getMatches(req.me.id);
    res.render('matches', { me: req.me, matches, categoryLabel: CATEGORY_LABELS, waLink });
  })
);

// ---- Admin ----

function requireAdmin(req, res, next) {
  if (req.query.key === ADMIN_KEY || req.body.key === ADMIN_KEY) return next();
  res.render('admin-login', { error: req.query.error ? 'Clé invalide.' : null });
}

app.get(
  '/admin',
  requireAdmin,
  ah(async (req, res) => {
    const people = await sql`SELECT * FROM people ORDER BY created_at DESC`;
    const [{ n: matchCount }] = await sql`SELECT COUNT(*)::int AS n FROM matches`;
    const counts = await categoryCounts('');

    res.render('admin', {
      people,
      matchCount,
      counts,
      categoryLabel: CATEGORY_LABELS,
      key: req.query.key,
    });
  })
);

app.post('/admin', (req, res) => {
  res.redirect(`/admin?key=${encodeURIComponent(req.body.key || '')}`);
});

// Wipes every registration, match, and uploaded photo — for clearing test
// data before an event, not something to run once real attendees are in.
app.post(
  '/admin/reset',
  requireAdmin,
  ah(async (req, res) => {
    let cursor;
    let hasMore = true;
    while (hasMore) {
      const listed = await list({ prefix: 'photos/', cursor, limit: 100 });
      await Promise.all(listed.blobs.map((b) => del(b.url)));
      cursor = listed.cursor;
      hasMore = listed.hasMore;
    }

    await sql`DELETE FROM matches`;
    await sql`DELETE FROM people`;

    res.redirect(`/admin?key=${encodeURIComponent(req.body.key || '')}`);
  })
);

app.get(
  '/admin/export.csv',
  requireAdmin,
  ah(async (req, res) => {
    const people = await sql`SELECT * FROM people ORDER BY created_at ASC`;
    const header = 'nom,occupation,categorie,email,telephone,created_at\n';
    const rows = people
      .map((p) =>
        [p.nom, p.occupation, p.categorie, p.email, p.telephone, p.created_at]
          .map((v) => `"${String(v || '').replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="participants.csv"');
    res.send(header + rows);
  })
);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Une erreur est survenue. Réessayez.');
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Networking Match app running on http://localhost:${PORT}`);
  });
}

module.exports = app;
