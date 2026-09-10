const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
// Trust Railway's (or any) reverse proxy so req.protocol reflects the real
// scheme (https) the browser used, not the internal http hop.
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'player.html'));
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'host.html'));
});

// Build the join URL from however the browser actually reached us —
// works automatically whether that's a public domain (Railway, any host)
// or a local IP on a LAN, with zero network-interface guessing.
app.get('/api/info', (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/`;
  res.json({ url });
});

// ---------- Game state (una sola sala) ----------
const players = new Map(); // socketId -> { id, name, score }
let armed = false;
let winner = null; // { id, name }

function rosterArray() {
  return Array.from(players.values()).sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name, 'es')
  );
}

function currentState() {
  return {
    phase: winner ? 'locked' : armed ? 'armed' : 'waiting',
    winner,
    playerCount: players.size,
  };
}

function broadcastPlayers() {
  io.to('hosts').emit('players', rosterArray());
}

function broadcastState() {
  io.emit('state', currentState());
}

function sanitizeName(raw) {
  const n = String(raw || '')
    .trim()
    .slice(0, 24);
  return n || 'Jugador';
}

io.on('connection', (socket) => {
  socket.data.role = null;

  socket.on('player:join', (rawName) => {
    const name = sanitizeName(rawName);
    socket.data.role = 'player';
    socket.data.name = name;
    players.set(socket.id, { id: socket.id, name, score: 0 });
    socket.emit('joined', { name });
    socket.emit('state', currentState());
    broadcastPlayers();
  });

  socket.on('player:buzz', () => {
    if (socket.data.role !== 'player') return;
    if (!armed || winner) return;
    armed = false;
    winner = { id: socket.id, name: socket.data.name };
    broadcastState();
    io.emit('buzzed', winner);
  });

  socket.on('host:hello', () => {
    socket.data.role = 'host';
    socket.join('hosts');
    socket.emit('players', rosterArray());
    socket.emit('state', currentState());
  });

  socket.on('host:arm', () => {
    if (socket.data.role !== 'host') return;
    winner = null;
    armed = true;
    broadcastState();
  });

  socket.on('host:reset', () => {
    if (socket.data.role !== 'host') return;
    winner = null;
    armed = false;
    broadcastState();
  });

  socket.on('host:award', (playerId) => {
    if (socket.data.role !== 'host') return;
    const p = players.get(playerId);
    if (p) p.score += 1;
    winner = null;
    armed = false;
    broadcastPlayers();
    broadcastState();
  });

  socket.on('host:adjust', ({ playerId, delta } = {}) => {
    if (socket.data.role !== 'host') return;
    const p = players.get(playerId);
    if (p) p.score = Math.max(0, p.score + (delta || 0));
    broadcastPlayers();
  });

  socket.on('host:kick', (playerId) => {
    if (socket.data.role !== 'host') return;
    const s = io.sockets.sockets.get(playerId);
    players.delete(playerId);
    if (winner && winner.id === playerId) {
      winner = null;
      armed = false;
      broadcastState();
    }
    broadcastPlayers();
    if (s) s.disconnect(true);
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'player') {
      players.delete(socket.id);
      broadcastPlayers();
    }
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🔔 En una nota — servidor corriendo en el puerto ' + PORT);
  console.log('  ------------------------------------');
  console.log('  Panel del anfitrión: /host');
  console.log('  Jugadores:           /');
  console.log('  ------------------------------------');
  console.log('');
});
