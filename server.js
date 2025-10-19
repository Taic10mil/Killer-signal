// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let price = 10000;
const ticks = [];

// Simulate random tick price movement
function simulateTick() {
  const delta = (Math.random() - 0.5) * 4;
  price = Math.max(1, price + delta);
  const tick = { ts: Date.now(), price: Number(price.toFixed(2)) };
  ticks.push(tick);
  if (ticks.length > 200) ticks.shift();
  return tick;
}

// Simple signal logic: compares short vs long average
function generateSignal() {
  if (ticks.length < 12) return null;
  const avg = arr => arr.reduce((sum, x) => sum + x, 0) / arr.length;
  const last3 = ticks.slice(-3).map(t => t.price);
  const last9 = ticks.slice(-9, -3).map(t => t.price);
  const avg3 = avg(last3);
  const avg9 = avg(last9);

  let direction = null;
  if (avg3 > avg9 + 0.2) direction = 'over';
  else if (avg3 < avg9 - 0.2) direction = 'under';
  else return null;

  return {
    id: 'sig_' + Date.now(),
    type: 'over_under',
    direction,
    price: ticks[ticks.length - 1].price,
    created_at: new Date().toISOString(),
    expiry_seconds: 60,
    confidence: Math.min(0.99, Math.abs((avg3 - avg9)) / 5)
  };
}

// Emit new ticks and signals every second
setInterval(() => {
  const tick = simulateTick();
  io.emit('tick', tick);

  const signal = generateSignal();
  if (signal) {
    io.emit('signal', signal);
    console.log('New Signal:', signal);
  }
}, 1000);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('hello', { message: 'Welcome to Deriv Signal Server' });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

app.get('/', (req, res) => res.send('✅ Deriv Signal Server is running...'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
