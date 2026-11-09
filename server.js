const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 12e6 });

const SIZE = 500;
const COOLDOWN_MS = 3000;
const MAX_IMAGE_SIDE = 500;
const DATA_DIR = path.join(__dirname, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read ${path.basename(file)}:`, error);
    return fallback;
  }
}

function writeJson(file, value) {
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value));
  fs.renameSync(tempFile, file);
}

const users = new Map(Object.entries(readJson(USERS_FILE, {})));
const pixels = new Map();

for (const [key, value] of Object.entries(readJson(BOARD_FILE, {}))) {
  let x, y;
  const coords = /^(\d+),(\d+)$/.exec(key);
  if (coords) { x = Number(coords[1]); y = Number(coords[2]); }
  else if (/^\d+$/.test(key)) {
    const id = Number(key);
    x = id % SIZE;
    y = Math.floor(id / SIZE);
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;

  const pixel = typeof value === 'string'
    ? { color: value, ownerId: null, ownerName: 'Anonim' }
    : value;
  if (!pixel || typeof pixel.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(pixel.color)) continue;

  pixels.set(y * SIZE + x, {
    color: pixel.color.toLowerCase(),
    ownerId: pixel.ownerId || null,
    ownerName: pixel.ownerName || 'Anonim',
    updatedAt: pixel.updatedAt || null
  });
}

let saveTimer;
function saveBoard() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const output = {};
      for (const [id, pixel] of pixels) {
        output[`${id % SIZE},${Math.floor(id / SIZE)}`] = pixel;
      }
      writeJson(BOARD_FILE, output);
    } catch (error) { console.error('Could not save board:', error); }
  }, 400);
}

function saveUsers() {
  try { writeJson(USERS_FILE, Object.fromEntries(users)); }
  catch (error) { console.error('Could not save users:', error); }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email || null,
    avatar: user.avatar || null,
    provider: user.provider
  };
}

function findUser(id) { return id ? users.get(id) || null : null; }

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('Set SESSION_SECRET env variable.');

const sessionMiddleware = session({
  store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), retries: 0, ttl: 86400 }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000 }
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, findUser(id)));

const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (googleConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  }, (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('No email from Google.'));

    let user = [...users.values()].find(item =>
      item.googleId === profile.id || item.email?.toLowerCase() === email.toLowerCase()
    );

    if (user) {
      user.googleId = profile.id;
      user.provider = user.passwordHash ? 'email+google' : 'google';
      user.avatar = profile.photos?.[0]?.value || user.avatar || null;
    } else {
      user = {
        id: `google:${profile.id}`,
        googleId: profile.id,
        name: profile.displayName || email.split('@')[0],
        email: email.toLowerCase(),
        avatar: profile.photos?.[0]?.value || null,
        provider: 'google',
        createdAt: Date.now()
      };
      users.set(user.id, user);
    }
    saveUsers();
    done(null, user);
  }));
}

const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const regenerateSession = req => new Promise((resolve, reject) =>
  req.session.regenerate(error => error ? reject(error) : resolve()));
const saveSession = req => new Promise((resolve, reject) =>
  req.session.save(error => error ? reject(error) : resolve()));

app.get('/api/me', (req, res) => {
  const user = findUser(req.session.userId);
  res.json({ user: user ? publicUser(user) : null, googleEnabled: googleConfigured });
});

app.post('/api/register', async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;

    if (name.length < 2) return res.status(400).json({ error: 'İsim en az 2 karakter olmalı.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi yaz.' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 200)
      return res.status(400).json({ error: 'Şifre 10–200 karakter olmalı.' });
    if ([...users.values()].some(user => user.email?.toLowerCase() === email))
      return res.status(409).json({ error: 'Bu e-posta zaten kayıtlı.' });

    const user = {
      id: `local:${crypto.randomUUID()}`,
      name, email, avatar: null, provider: 'email',
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: Date.now()
    };
    users.set(user.id, user);
    saveUsers();

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.status(201).json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    const user = [...users.values()].find(item =>
      item.email?.toLowerCase() === email && item.passwordHash);

    if (!user || typeof password !== 'string' || !await bcrypt.compare(password, user.passwordHash))
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/logout',
