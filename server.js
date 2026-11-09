const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const WIDTH = 16000;
const HEIGHT = 16000;
const COOLDOWN_MS = 3000;
const MAX_IMAGE_SIDE = 32;
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
  console.log(`Loaded ${board.size} Bonkistan pixels.`);
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

function checkCooldown(socket) {
  const now = Date.now();
  const wait = COOLDOWN_MS - (now - (socket.data.lastPaintAt || 0));
  if (wait > 0) return { ok: false, wait };
  socket.data.lastPaintAt = now;
  return { ok: true, nextPaintAt: now + COOLDOWN_MS };
}

io.on('connection', socket => {
  socket.emit('init', Object.fromEntries(board));

  socket.on('place', (pixel, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!pixel || !Number.isInteger(pixel.x) || !Number.isInteger(pixel.y) ||
        pixel.x < 0 || pixel.x >= WIDTH || pixel.y < 0 || pixel.y >= HEIGHT ||
        typeof pixel.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(pixel.color)) {
      reply({ ok: false, error: 'Geçersiz piksel veya renk.' });
      return;
    }
    const cooldown = checkCooldown(socket);
    if (!cooldown.ok) return reply(cooldown);
    const update = { x: pixel.x, y: pixel.y, color: pixel.color.toLowerCase() };
    board.set(`${update.x},${update.y}`, update.color);
    io.emit('update', update);
    saveBoard();
    reply(cooldown);
  });

  socket.on('placeImage', (image, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!image || !Number.isInteger(image.x) || !Number.isInteger(image.y) ||
        !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
        image.width < 1 || image.width > MAX_IMAGE_SIDE || image.height < 1 || image.height > MAX_IMAGE_SIDE ||
        image.x < 0 || image.y < 0 || image.x + image.width > WIDTH || image.y + image.height > HEIGHT ||
        !Array.isArray(image.pixels) || image.pixels.length !== image.width * image.height ||
        image.pixels.some(color => color !== null && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)))) {
      reply({ ok: false, error: `Resim en fazla ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE} piksel olmalı ve haritanın içine sığmalı.` });
      return;
    }
    const cooldown = checkCooldown(socket);
    if (!cooldown.ok) return reply(cooldown);
    const updates = [];
    image.pixels.forEach((color, index) => {
      if (!color) return;
      const x = image.x + (index % image.width);
      const y = image.y + Math.floor(index / image.width);
      const update = { x, y, color: color.toLowerCase() };
      board.set(`${x},${y}`, update.color);
      updates.push(update);
    });
    io.emit('imageUpdate', updates);
    saveBoard();
    reply({ ...cooldown, count: updates.length });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Bonkistan Pixel Savaşı listening on ${PORT}`));
