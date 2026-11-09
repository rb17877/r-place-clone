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
// A 500×500 RGBA image encoded as JSON can be several megabytes.
const io = new Server(server, { maxHttpBufferSize: 12e6 });
const SIZE = 16000;
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
  else if (/^\d+$/.test(key)) { const id = Number(key); x = id % SIZE; y = Math.floor(id / SIZE); }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
  const pixel = typeof value === 'string' ? { color: value, ownerId: null, ownerName: 'Anonim' } : value;
  if (!pixel || typeof pixel.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(pixel.color)) continue;
  pixels.set(y * SIZE + x, { color: pixel.color.toLowerCase(), ownerId: pixel.ownerId || null, ownerName: pixel.ownerName || 'Anonim', updatedAt: pixel.updatedAt || null });
}
let saveTimer;
function saveBoard() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const output = {};
      for (const [id, pixel] of pixels) output[`${id % SIZE},${Math.floor(id / SIZE)}`] = pixel;
      writeJson(BOARD_FILE, output);
    } catch (error) { console.error('Could not save board:', error); }
  }, 400);
}
function saveUsers() {
  try { writeJson(USERS_FILE, Object.fromEntries(users)); }
  catch (error) { console.error('Could not save users:', error); }
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email || null, avatar: user.avatar || null, provider: user.provider };
}
function findUser(id) { return id ? users.get(id) || null : null; }

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('Set SESSION_SECRET to keep sessions valid across server restarts.');
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
    if (!email) return done(new Error('Google hesabından e-posta alınamadı.'));
    let user = [...users.values()].find(item => item.googleId === profile.id || item.email?.toLowerCase() === email.toLowerCase());
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
const regenerateSession = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

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
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Şifre 10–200 karakter olmalı.' });
    if ([...users.values()].some(user => user.email?.toLowerCase() === email)) return res.status(409).json({ error: 'Bu e-posta zaten kayıtlı.' });
    const user = { id: `local:${crypto.randomUUID()}`, name, email, avatar: null, provider: 'email', passwordHash: await bcrypt.hash(password, 12), createdAt: Date.now() };
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
    const user = [...users.values()].find(item => item.email?.toLowerCase() === email && item.passwordHash);
    if (!user || typeof password !== 'string' || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});
app.post('/api/logout', (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('connect.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});
if (googleConfigured) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], state: true }));
  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?authError=google' }), async (req, res, next) => {
    try {
      const user = req.user;
      await regenerateSession(req);
      req.session.userId = user.id;
      await saveSession(req);
      res.redirect('/');
    } catch (error) { next(error); }
  });
} else {
  app.get('/auth/google', (_req, res) => res.status(503).send('Google girişi için GOOGLE_CLIENT_ID ve GOOGLE_CLIENT_SECRET ayarlanmalı.'));
}
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.engine.use(sessionMiddleware);
const lastPlaced = new Map();
const ack = (callback, result) => { if (typeof callback === 'function') callback(result); };
io.on('connection', socket => {
  const user = findUser(socket.request.session?.userId);
  socket.emit('init', { size: SIZE, pixels: [...pixels] });
  socket.on('place', (pixel, callback) => {
    if (!user) return ack(callback, { ok: false, error: 'Piksel boyamak için giriş yapmalısın.' });
    if (!pixel || !Number.isInteger(pixel.x) || !Number.isInteger(pixel.y) || pixel.x < 0 || pixel.y < 0 || pixel.x >= SIZE || pixel.y >= SIZE || typeof pixel.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(pixel.color)) {
      return ack(callback, { ok: false, error: 'Piksel bilgisi geçersiz.' });
    }
    const now = Date.now();
    const wait = COOLDOWN_MS - (now - (lastPlaced.get(socket.id) || 0));
    if (wait > 0) return ack(callback, { ok: false, wait });
    lastPlaced.set(socket.id, now);
    const update = { x: pixel.x, y: pixel.y, color: pixel.color.toLowerCase(), ownerId: user.id, ownerName: user.name, updatedAt: now };
    pixels.set(pixel.y * SIZE + pixel.x, update);
    io.emit('update', update);
    saveBoard();
    ack(callback, { ok: true, nextPaintAt: now + COOLDOWN_MS });
  });
  socket.on('placeImage', (image, callback) => {
    if (!user) return ack(callback, { ok: false, error: 'Resim yerleştirmek için giriş yapmalısın.' });
    if (!image || !Number.isInteger(image.x) || !Number.isInteger(image.y) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.width > MAX_IMAGE_SIDE || image.height < 1 || image.height > MAX_IMAGE_SIDE || image.x < 0 || image.y < 0 || image.x + image.width > SIZE || image.y + image.height > SIZE || !Array.isArray(image.pixels) || image.pixels.length !== image.width * image.height || image.pixels.some(color => color !== null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)))) {
      return ack(callback, { ok: false, error: 'Resim geçersiz veya harita sınırlarının dışında. Resim en fazla 500×500 piksel olabilir.' });
    }
    const now = Date.now();
    const wait = COOLDOWN_MS - (now - (lastPlaced.get(socket.id) || 0));
    if (wait > 0) return ack(callback, { ok: false, wait });
    lastPlaced.set(socket.id, now);
    const updates = [];
    image.pixels.forEach((color, index) => {
      if (!color) return;
      const x = image.x + index % image.width;
      const y = image.y + Math.floor(index / image.width);
      const update = { x, y, color: color.toLowerCase(), ownerId: user.id, ownerName: user.name, updatedAt: now };
      pixels.set(y * SIZE + x, update);
      updates.push(update);
    });
    io.emit('imageUpdate', updates);
    saveBoard();
    ack(callback, { ok: true, nextPaintAt: now + COOLDOWN_MS, count: updates.length });
  });
  socket.on('disconnect', () => lastPlaced.delete(socket.id));
});
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Sunucu hatası oluştu.' });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Bonkistan server listening on ${PORT}`));
