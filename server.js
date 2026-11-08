const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const GRID_SIZE = 50;
const grid = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill('#ffffff'));

io.on('connection', (socket) => {
    socket.emit('initGrid', grid);

    socket.on('paintPixel', ({ x, y, color }) => {
        if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
            grid[y][x] = color;
            io.emit('updatePixel', { x, y, color });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
