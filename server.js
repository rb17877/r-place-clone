const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statik dosyalar: __dirname kullanmak, çalışma dizininden bağımsız olarak doğru yolu verir
app.use(express.static(path.join(__dirname, 'public')));

// Garanti olsun diye ana sayfayı açıkça tanımla
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const SIZE = 50;
const board = Array.from({ length: SIZE }, () => Array(SIZE).fill('#ffffff'));

io.on('connection', (socket) => {
  socket.emit('init', board);

  socket.on('place', ({ x, y, color }) => {
    if (x >= 0 && x < SIZE && y >= 0 && y < SIZE && typeof color === 'string') {
      board[y][x] = color;
      io.emit('update', { x, y, color });
    }
  });
});

// Render PORT'u ortam değişkeniyle verir; sabit port kullanma
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor`);
});
