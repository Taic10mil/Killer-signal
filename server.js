// server.js — Deriv-connected server with SQLite logging and ensemble scoring
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONFIG ---
const DERIV_WS = 'wss://ws.binaryws.com/websockets/v3';
const SYMBOL = process.env.SYMBOL || 'R_100';
const CONF_THRESHOLD = Number(process.env.CONF_THRESHOLD || 0.65); // require score >= this
const TICK_BUFFER = 500;
const PORT = process.env.PORT || 3000;

// --- DB setup (sqlite local file) ---
const DB_PATH = path.join(__dirname, 'signals.db');
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, price REAL)`);
  db.run(`CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, ts INTEGER, type TEXT, direction TEXT, price REAL, score REAL, confidence REAL, expiry_seconds INTEGER)`);
});

// --- Tick buffer & helpers ---
let ticks = []; // { ts: ms, price }
function pushTick(t) {
  ticks.push(t);
  if (ticks.length > TICK_BUFFER) ticks.shift();
  // persist tick
  db.run('INSERT INTO ticks (ts, price) VALUES (?, ?)', [t.ts, t.price]);
}

// feature helpers
function sma(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s,x)=>s+x,0)/n;
}
function stdev(arr, n) {
  if (arr.length < n) return 0;
  const slice = arr.slice(-n);
  const mean = slice.reduce((s,x)=>s+x,0)/n;
  const v = slice.reduce((s,x)=>s + Math.pow(x - mean,2),0)/n;
  return Math.sqrt(v);
}

// ensemble scoring: weighted features -> score 0..1
function computeScore() {
  if (ticks.length < 20) return 0;
  const prices = ticks.map(t=>t.price);
  const ma3 = sma(prices, 3);
  const ma9 = sma(prices, 9);
  const ma20 = sma(prices, 20);
  const vol5 = stdev(prices, 5);
  const vol20 = stdev(prices, 20);

  // features (normalized heuristics)
  const momentum = (ma3 - ma9); // positive -> upward bias
  const trend = (ma9 - ma20);
  const volRatio = vol5 / (vol20 + 1e-9);

  // normalize / convert to roughly 0..1 contributions
  const mScore = Math.tanh(momentum / 2) * 0.5 + 0.5; // maps to 0..1
  const tScore = Math.tanh(trend / 2) * 0.5 + 0.5;
  const vScore = 1 - Math.tanh(volRatio); // prefer lower short-term relative vol for some strategies

  // weights — you can tune these later via backtest
  const w = { m: 0.45, t: 0.35, v: 0.20 };
  const raw = (mScore * w.m) + (tScore * w.t) + (vScore * w.v);
  // map raw to 0..1
  const score = Math.min(1, Math.max(0, raw));
  // direction determined by sign of momentum+trend
  const dirVal = (momentum + trend);
  const direction = dirVal > 0 ? 'over' : 'under';
  return { score, direction, details: { mScore, tScore, vScore, momentum, trend, volRatio } };
}

// --- Socket.io clients ---
io.on('connection', socket => {
  console.log('Client connected', socket.id);
  socket.emit('hello', { now: Date.now() });
  socket.on('disconnect', () => console.log('Client disconnected', socket.id));
});

// Serve frontend if present
app.use(express.static(path.join(__dirname, 'public'))); // put index.html in /public

app.get('/health', (req,res) => res.json({ ok: true }));

// --- Deriv WebSocket connection ---
const TOKEN = process.env.DERIV_TOKEN || '';
if (!TOKEN) {
  console.error('DERIV_TOKEN not set. Use demo token for testing.');
  // we don't exit — keep server running so frontend can be tested with simulated ticks if you add them
}

let ws;
function connectDeriv() {
  ws = new WebSocket(DERIV_WS);
  ws.on('open', () => {
    console.log('Connected to Deriv WS — authorizing...');
    if (TOKEN) ws.send(JSON.stringify({ authorize: TOKEN }));
    else {
      console.warn('No token found — you can still test by pasting ticks manually into DB or using a simulator.');
    }
  });

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.authorize) {
        console.log('Authorized. Subscribing to ticks:', SYMBOL);
        ws.send(JSON.stringify({ ticks: SYMBOL }));
        return;
      }
      if (data.error) {
        console.error('Deriv error', data.error);
      }
      if (data.tick && typeof data.tick.quote !== 'undefined') {
        const tick = { ts: data.tick.epoch * 1000, price: Number(data.tick.quote) };
        onDerivTick(tick);
      }
    } catch (e) {
      console.error('WS parse error', e);
    }
  });

  ws.on('close', () => {
    console.log('Deriv WS closed — reconnecting in 3s');
    setTimeout(connectDeriv, 3000);
  });
  ws.on('error', err => console.error('Deriv WS error', err));
}
connectDeriv();

// --- tick handler & signal emission ---
let lastSignalTs = 0;
const SIGNAL_COOLDOWN_MS = 30000; // don't fire signals more often than this by default

function onDerivTick(tick) {
  pushTick(tick);
  io.emit('tick', tick);

  // compute score & possibly emit signal
  const { score, direction, details } = computeScore();
  // apply cooldown and threshold
  if (score >= CONF_THRESHOLD && (Date.now() - lastSignalTs) > SIGNAL_COOLDOWN_MS) {
    lastSignalTs = Date.now();
    const signal = {
      id: 'sig_' + Date.now(),
      ts: Date.now(),
      type: 'over_under',
      direction,
      price: tick.price,
      score,
      confidence: score, // alias
      expiry_seconds: 60
    };
    // persist signal
    db.run('INSERT OR REPLACE INTO signals (id, ts, type, direction, price, score, confidence, expiry_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [signal.id, signal.ts, signal.type, signal.direction, signal.price, signal.score, signal.confidence, signal.expiry_seconds]);
    io.emit('signal', signal);
    console.log('EMIT SIGNAL', signal);
  }
}

// start server
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
