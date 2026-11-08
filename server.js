const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DATA_DIR = path.join(__dirname, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const COOLDOWN_MS = 3000;
const MAX_COORD = 1000000;
const board = new Map();

function loadBoard() {
  try {
    const raw = fs.readFileSync(BOARD_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [key, color] of Object.entries(parsed)) {
      if (/^-?\d+,-?\d+$/.test(key) && /^#[0-9a-fA-F]{6}$/.test(color)) {
        board.set(key, color.toLowerCase());
      }
    }
    console.log(`Loaded ${board.size} painted pixels.`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to load saved board:', error);
    }
  }
}

let saveTimer = null;
function saveBoard() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tempFile = `${BOARD_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(Object.fromEntries(board)));
      fs.renameSync(tempFile, BOARD_FILE);
      console.log('Board saved.');
    } catch (error) {
      console.error('Failed to save board:', error);
    }
  }, 500);
}

loadBoard();

io.on('connection', (socket) => {
  socket.emit('init', Object.fromEntries(board));

  socket.on('place', (pixel, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};

    if (!pixel || !Number.isInteger(pixel.x) || !Number.isInteger(pixel.y)) {
      reply({ ok: false, error: 'Invalid pixel coordinates.' });
      return;
    }

    if (Math.abs(pixel.x) > MAX_COORD || Math.abs(pixel.y) > MAX_COORD) {
      reply({ ok: false, error: 'Coordinates out of range.' });
      return;
    }

    if (typeof pixel.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(pixel.color)) {
      reply({ ok: false, error: 'Invalid color.' });
      return;
    }

    const now = Date.now();
    const lastPaintAt = socket.data.lastPaintAt || 0;
    const timeLeft = COOLDOWN_MS - (now - lastPaintAt);
    if (timeLeft > 0) {
      reply({ ok: false, wait: timeLeft });
      return;
    }

    socket.data.lastPaintAt = now;

    const normalizedColor = pixel.color.toLowerCase();
    const key = `${pixel.x},${pixel.y}`;
    board.set(key, normalizedColor);
    io.emit('update', { x: pixel.x, y: pixel.y, color: normalizedColor });
    saveBoard();

    reply({ ok: true, nextPaintAt: now + COOLDOWN_MS });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bonkistan is running on port ${PORT}`);
});
