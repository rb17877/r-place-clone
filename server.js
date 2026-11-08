const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// A world canvas: one paintable pixel per degree of longitude/latitude.
const WIDTH = 360;
const HEIGHT = 180;
const COOLDOWN_MS = 3000;
const BOARD_FILE = path.join(__dirname, 'data', 'board.json');
const board = new Map();

try {
  const saved = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
  for (const [key, color] of Object.entries(saved)) {
    const match = /^(\d+),(\d+)$/.exec(key);
    if (match && Number(match[1]) < WIDTH && Number(match[2]) < HEIGHT && /^#[0-9a-fA-F]{6}$/.test(color)) {
      board.set(key, color.toLowerCase());
    }
  }
  console.log(`Loaded ${board.size} world-map pixels.`);
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not load board:', error);
}

let saveTimer;
function saveBoard() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(BOARD_FILE), { recursive: true });
      const tempFile = `${BOARD_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(Object.fromEntries(board)));
      fs.renameSync(tempFile, BOARD_FILE);
    } catch (error) {
      console.error('Could not save board:', error);
    }
  }, 400);
}

io.on('connection', (socket) => {
  socket.emit('init', Object.fromEntries(board));
  socket.on('place', (pixel, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!pixel || !Number.isInteger(pixel.x) || !Number.isInteger(pixel.y) ||
        pixel.x < 0 || pixel.x >= WIDTH || pixel.y < 0 || pixel.y >= HEIGHT ||
        typeof pixel.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(pixel.color)) {
      reply({ ok: false, error: 'Geçersiz harita konumu veya renk.' });
      return;
    }

    const now = Date.now();
    const wait = COOLDOWN_MS - (now - (socket.data.lastPaintAt || 0));
    if (wait > 0) {
      reply({ ok: false, wait });
      return;
    }

    socket.data.lastPaintAt = now;
    const update = { x: pixel.x, y: pixel.y, color: pixel.color.toLowerCase() };
    board.set(`${update.x},${update.y}`, update.color);
    io.emit('update', update);
    saveBoard();
    reply({ ok: true, nextPaintAt: now + COOLDOWN_MS });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Bonkistan world map is running on port ${PORT}`));
