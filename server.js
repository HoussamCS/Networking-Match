require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const { randomUUID } = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changez-moi';

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname) || '';
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
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

const CATEGORIES = [
  { value: 'entrepreneur', label: 'Entrepreneur' },
  { value: 'investisseur', label: 'Investisseur' },
  { value: 'associe', label: 'Associé' },
  { value: 'autre', label: 'Autre' },
];
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function getPerson(id) {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id);
}

function categoryCounts(excludeId) {
  const rows = db
    .prepare(
      `SELECT categorie, COUNT(*) as n FROM people WHERE id != ? GROUP BY categorie`
    )
    .all(excludeId || '');
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.value, 0]));
  rows.forEach((r) => {
    counts[r.categorie] = r.n;
  });
  return counts;
}

// already matched (in either direction) between two people
function alreadyMatchedIds(personId) {
  const rows = db
    .prepare(
      `SELECT matched_person_id AS pid FROM matches WHERE person_id = ?
       UNION
       SELECT person_id AS pid FROM matches WHERE matched_person_id = ?`
    )
    .all(personId, personId);
  return rows.map((r) => r.pid);
}

function findMatch(personId, categorie) {
  const seen = alreadyMatchedIds(personId);
  const placeholders = seen.length ? seen.map(() => '?').join(',') : null;

  let candidates = db
    .prepare(
      `SELECT * FROM people WHERE categorie = ? AND id != ?` +
        (placeholders ? ` AND id NOT IN (${placeholders})` : '')
    )
    .all(categorie, personId, ...seen);

  // pool exhausted -> allow repeats, just exclude self
  if (candidates.length === 0) {
    candidates = db
      .prepare(`SELECT * FROM people WHERE categorie = ? AND id != ?`)
      .all(categorie, personId);
  }

  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];

  db.prepare(
    `INSERT INTO matches (person_id, matched_person_id) VALUES (?, ?)`
  ).run(personId, pick.id);

  return pick;
}

// ---- Routes ----

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/register', (req, res) => {
  res.render('register', { categories: CATEGORIES, error: null });
});

app.post('/register', uploadPhoto, (req, res) => {
  const { nom, occupation, categorie, email, telephone } = req.body;

  if (!nom || !nom.trim() || !CATEGORY_LABELS[categorie]) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).render('register', {
      categories: CATEGORIES,
      error: 'Merci de renseigner au moins votre nom et votre catégorie.',
    });
  }

  const id = randomUUID();
  const photo = req.file ? req.file.filename : null;
  db.prepare(
    `INSERT INTO people (id, nom, occupation, categorie, email, telephone, photo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, nom.trim(), (occupation || '').trim(), categorie, (email || '').trim(), (telephone || '').trim(), photo);

  res.redirect(`/profile/${id}`);
});

app.get('/profile/:id', async (req, res) => {
  const person = getPerson(req.params.id);
  if (!person) return res.status(404).send('Profil introuvable.');

  const matchUrl = `${baseUrl(req)}/match/${person.id}`;
  const qrDataUrl = await QRCode.toDataURL(matchUrl, { margin: 1, width: 320 });

  res.render('profile', {
    person,
    qrDataUrl,
    matchUrl,
    categoryLabel: CATEGORY_LABELS[person.categorie],
  });
});

app.get('/match/:id', (req, res) => {
  const person = getPerson(req.params.id);
  if (!person) return res.status(404).send('Profil introuvable.');

  const counts = categoryCounts(person.id);

  res.render('match', {
    person,
    categories: CATEGORIES,
    counts,
    categoryLabel: CATEGORY_LABELS[person.categorie],
  });
});

app.post('/match/:id', (req, res) => {
  const person = getPerson(req.params.id);
  if (!person) return res.status(404).send('Profil introuvable.');

  const { categorie } = req.body;
  if (!CATEGORY_LABELS[categorie]) return res.redirect(`/match/${person.id}`);

  const match = findMatch(person.id, categorie);

  res.render('result', {
    person,
    match,
    categorie,
    categoryLabel: CATEGORY_LABELS[categorie],
  });
});

// ---- Admin ----

function requireAdmin(req, res, next) {
  if (req.query.key === ADMIN_KEY || req.body.key === ADMIN_KEY) return next();
  res.render('admin-login', { error: req.query.error ? 'Clé invalide.' : null });
}

app.get('/admin', requireAdmin, (req, res) => {
  const people = db.prepare('SELECT * FROM people ORDER BY created_at DESC').all();
  const matchCount = db.prepare('SELECT COUNT(*) AS n FROM matches').get().n;
  const counts = categoryCounts('');

  res.render('admin', {
    people,
    matchCount,
    counts,
    categoryLabel: CATEGORY_LABELS,
    key: req.query.key,
  });
});

app.post('/admin', (req, res) => {
  res.redirect(`/admin?key=${encodeURIComponent(req.body.key || '')}`);
});

app.get('/admin/export.csv', requireAdmin, (req, res) => {
  const people = db.prepare('SELECT * FROM people ORDER BY created_at ASC').all();
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
});

app.listen(PORT, () => {
  console.log(`Networking Match app running on http://localhost:${PORT}`);
});
