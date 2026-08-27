require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { put, get } = require('@vercel/blob');
const { Readable } = require('stream');
const QRCode = require('qrcode');
const { randomUUID } = require('crypto');
const { sql, ready } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changez-moi';

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
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  ah(async (req, res, next) => {
    await ready();
    next();
  })
);

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

async function getPerson(id) {
  const rows = await sql`SELECT * FROM people WHERE id = ${id}`;
  return rows[0];
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

// already matched (in either direction) between two people
async function alreadyMatchedIds(personId) {
  const rows = await sql`
    SELECT matched_person_id AS pid FROM matches WHERE person_id = ${personId}
    UNION
    SELECT person_id AS pid FROM matches WHERE matched_person_id = ${personId}
  `;
  return rows.map((r) => r.pid);
}

async function findMatch(personId, categorie) {
  const seen = await alreadyMatchedIds(personId);

  let candidates = await sql`
    SELECT * FROM people
    WHERE categorie = ${categorie}
      AND id != ${personId}
      AND id != ALL(${seen}::text[])
  `;

  // pool exhausted -> allow repeats, just exclude self
  if (candidates.length === 0) {
    candidates = await sql`
      SELECT * FROM people WHERE categorie = ${categorie} AND id != ${personId}
    `;
  }

  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];

  await sql`INSERT INTO matches (person_id, matched_person_id) VALUES (${personId}, ${pick.id})`;

  return pick;
}

// ---- Routes ----

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/register', (req, res) => {
  res.render('register', { categories: CATEGORIES, error: null });
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
    const { nom, occupation, categorie, email, telephone } = req.body;

    if (!nom || !nom.trim() || !CATEGORY_LABELS[categorie]) {
      return res.status(400).render('register', {
        categories: CATEGORIES,
        error: 'Merci de renseigner au moins votre nom et votre catégorie.',
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
    await sql`
      INSERT INTO people (id, nom, occupation, categorie, email, telephone, photo)
      VALUES (${id}, ${nom.trim()}, ${(occupation || '').trim()}, ${categorie}, ${(email || '').trim()}, ${(telephone || '').trim()}, ${photo})
    `;

    res.redirect(`/profile/${id}`);
  })
);

app.get(
  '/profile/:id',
  ah(async (req, res) => {
    const person = await getPerson(req.params.id);
    if (!person) return res.status(404).send('Profil introuvable.');

    const matchUrl = `${baseUrl(req)}/match/${person.id}`;
    const qrDataUrl = await QRCode.toDataURL(matchUrl, { margin: 1, width: 320 });

    res.render('profile', {
      person,
      qrDataUrl,
      matchUrl,
      categoryLabel: CATEGORY_LABELS[person.categorie],
    });
  })
);

app.get(
  '/match/:id',
  ah(async (req, res) => {
    const person = await getPerson(req.params.id);
    if (!person) return res.status(404).send('Profil introuvable.');

    const counts = await categoryCounts(person.id);

    res.render('match', {
      person,
      categories: CATEGORIES,
      counts,
      categoryLabel: CATEGORY_LABELS[person.categorie],
    });
  })
);

app.post(
  '/match/:id',
  ah(async (req, res) => {
    const person = await getPerson(req.params.id);
    if (!person) return res.status(404).send('Profil introuvable.');

    const { categorie } = req.body;
    if (!CATEGORY_LABELS[categorie]) return res.redirect(`/match/${person.id}`);

    const match = await findMatch(person.id, categorie);

    res.render('result', {
      person,
      match,
      categorie,
      categoryLabel: CATEGORY_LABELS[categorie],
    });
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
