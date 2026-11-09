const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const SIZE = 16000;
const COOLDOWN_MS = 3000;
const MAX_IMAGE_SIDE = 32;
const BOARD_FILE = path.join(__dirname, 'data', 'board.json');
// Sparse storage: key is y * SIZE + x, value is a lowercase #rrggbb color.
const pixels = new Map();
const lastPlaced = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function pixelKey(x, y) {
  return y * SIZE + x;
}

function isValidColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
}

// Read older boards stored with "x,y" keys as well as linear-key boards.
try {
  const saved = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
  for (const [key, color] of Object.entries(saved)) {
    if (!isValidColor(color)) continue;
    const coords = /^(\d+),(\d+)$/.exec(key);
    if (coords) {
      const x = Number(coords[1]);
      const y = Number(coords[2]);
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) pixels.set(pixelKey(x, y), color.toLowerCase());
      continue;
    }
    if (/^\d+$/.test(key)) {
      const linearKey = Number(key);
      if (Number.isSafeInteger(linearKey) && linearKey >= 0 && linearKey < SIZE * SIZE) {
        pixels.set(linearKey, color.toLowerCase());
      }
    }
  }
  console.log(`Loaded ${pixels.size} Bonkistan pixels.`);
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not load board:', error);
}

let saveTimer;
function saveBoard() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(BOARD_FILE), { recursive: true });
      const serializable = {};
      for (const [key, color] of pixels) {
        const x = key % SIZE;
        const y = Math.floor(key / SIZE);
        serializable[`${x},${y}`] = color;
      }
      const tempFile = `${BOARD_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(serializable));
      fs.renameSync(tempFile, BOARD_FILE);
    } catch (error) {
      console.error('Could not save board:', error);
    }
  }, 400);
}

function checkCooldown(socket) {
  const now = Date.now();
  const last = lastPlaced.get(socket.id) || 0;
  const wait = COOLDOWN_MS - (now - last);
  if (wait > 0) return { ok: false, wait };
  lastPlaced.set(socket.id, now);
  return { ok: true, nextPaintAt: now + COOLDOWN_MS };
}

io.on('connection', socket => {
  // Keep the existing browser client's "x,y" key protocol compatible.
  const initialPixels = {};
  for (const [key, color] of pixels) {
    initialPixels[`${key % SIZE},${Math.floor(key / SIZE)}`] = color;
  }
  socket.emit('init', initialPixels);

  socket.on('place', (pixel, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!pixel || !Number.isInteger(pixel.x) || !Number.isInteger(pixel.y) ||
        pixel.x < 0 || pixel.y < 0 || pixel.x >= SIZE || pixel.y >= SIZE ||
        !isValidColor(pixel.color)) {
      reply({ ok: false, error: 'Geçersiz piksel veya renk.' });
      return;
    }

    const cooldown = checkCooldown(socket);
    if (!cooldown.ok) {
      reply(cooldown);
      return;
    }

    const update = { x: pixel.x, y: pixel.y, color: pixel.color.toLowerCase() };
    pixels.set(pixelKey(update.x, update.y), update.color);
    io.emit('update', update);
    saveBoard();
    reply(cooldown);
  });

  // Image placement is used by the upload controls in public/index.html.
  socket.on('placeImage', (image, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!image || !Number.isInteger(image.x) || !Number.isInteger(image.y) ||
        !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
        image.width < 1 || image.width > MAX_IMAGE_SIDE ||
        image.height < 1 || image.height > MAX_IMAGE_SIDE ||
        image.x < 0 || image.y < 0 || image.x + image.width > SIZE || image.y + image.height > SIZE ||
        !Array.isArray(image.pixels) || image.pixels.length !== image.width * image.height ||
        image.pixels.some(color => color !== null && !isValidColor(color))) {
      reply({ ok: false, error: `Resim en fazla ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE} piksel olmalı ve haritanın içine sığmalı.` });
      return;
    }

    const cooldown = checkCooldown(socket);
    if (!cooldown.ok) {
      reply(cooldown);
      return;
    }

    const updates = [];
    image.pixels.forEach((color, index) => {
      if (!color) return;
      const x = image.x + (index % image.width);
      const y = image.y + Math.floor(index / image.width);
      const update = { x, y, color: color.toLowerCase() };
      pixels.set(pixelKey(x, y), update.color);
      updates.push(update);
    });

    io.emit('imageUpdate', updates);
    saveBoard();
    reply({ ...cooldown, count: updates.length });
  });

  socket.on('disconnect', () => lastPlaced.delete(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port ${PORT}`));
