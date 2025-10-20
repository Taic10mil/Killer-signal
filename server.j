// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DERIV_WS = 'wss://ws.binaryws.com/websockets/v3';
const SYMBOL_MAIN = process.env.SYMBOL_MAIN || 'R_100';
const SYMBOL_ALT  = process.env.SYMBOL_ALT || 'R_25';
const TOKEN = process.env.DERIV_TOKEN || ''; // set in env (demo token)
const CONF_THRESHOLD = Number(process.env.CONF_THRESHOLD || 0.60);
const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS || 5000);

let bufMain = [];
let bufAlt = [];
const MAX_BUF = 1000;

function pushBuf(buf, price) {
  buf.push(price);
  if (buf.length > MAX_BUF) buf.shift();
}
function sma(arr, n) {
  if (arr.length < n) return null;
  const s = arr.slice(-n).reduce((a,b)=>a+b,0);
  return s / n;
}
function stdev(arr, n) {
  if (arr.length < n) return 0;
  const sl = arr.slice(-n);
  const mean = sl.reduce((a,b)=>a+b,0)/n;
  const v = sl.reduce((a,b)=>a + (b-mean)*(b-mean),0)/n;
  return Math.sqrt(v);
}
function computeEnsemble(prices) {
  if (prices.length < 12) return {score:0, direction:'none', details:null};
  const ma3 = sma(prices,3);
  const ma9 = sma(prices,9);
  const ma20 = sma(prices,20);
  const vol5 = stdev(prices,5);
  const vol20 = stdev(prices,20);

  const momentum = (ma3 - ma9);
  const trend = (ma9 - ma20);
  const volRatio = vol5/(vol20+1e-9);

  const mScore = (Math.tanh(momentum/2)+1)/2;
  const tScore = (Math.tanh(trend/2)+1)/2;
  const vScore = 1 - Math.tanh(volRatio);

  const weights = {m:0.5, t:0.35, v:0.15};
  let raw = mScore*weights.m + tScore*weights.t + vScore*weights.v;
  raw = Math.max(0, Math.min(1, raw));
  const dirVal = momentum + trend;
  const direction = dirVal >= 0 ? 'over' : 'under';
  return {score:raw, direction, details:{mScore,tScore,vScore,momentum,trend,volRatio}};
}
function parityConfidence(price) {
  const last = Math.floor(price) % 10;
  const even = (last % 2 === 0);
  const bonus = [0,2,4,6,8].includes(last) ? 0.03 : 0;
  const conf = Math.min(0.99, 0.5 + bonus);
  return {parity: even ? 'even' : 'odd', conf};
}

let lastSignal = 0;

function maybeEmitSignals(priceMain) {
  const now = Date.now();
  if ((now - lastSignal) < SIGNAL_COOLDOWN_MS) return;

  const ensemble = computeEnsemble(bufMain);
  const parity = parityConfidence(priceMain);

  if (ensemble.score >= CONF_THRESHOLD) {
    lastSignal = now;
    const s = {
      id: 'sig_' + now,
      ts: now,
      type: 'over_under',
      direction: ensemble.direction,
      price: priceMain,
      score: ensemble.score,
      confidence: ensemble.score,
      expiry_seconds: 60,
      details: ensemble.details
    };
    io.emit('signal', s);
    console.log('EMIT OVER_UNDER', s);
  }

  if (parity.conf >= 0.55 && (now - lastSignal) >= SIGNAL_COOLDOWN_MS) {
    lastSignal = now;
    const s = {
      id: 'sig_' + now + '_par',
      ts: now,
      type: 'even_odd',
      direction: parity.parity,
      price: priceMain,
      score: parity.conf,
      confidence: parity.conf,
      expiry_seconds: 60
    };
    io.emit('signal', s);
    console.log('EMIT EVEN_ODD', s);
  }

  if (bufMain.length >= 9 && bufAlt.length >= 9 && (now - lastSignal) >= SIGNAL_COOLDOWN_MS) {
    const mDiff = sma(bufMain,3) - sma(bufMain,9);
    const aDiff = sma(bufAlt,3) - sma(bufAlt,9);
    const diff = mDiff - aDiff;
    const conf = Math.min(0.95, Math.abs(diff)/5 + 0.45);
    if (conf > 0.6) {
      lastSignal = now;
      const s = {
        id: 'sig_' + now + '_match',
        ts: now,
        type: 'matches',
        direction: diff > 0 ? SYMBOL_MAIN : SYMBOL_ALT,
        price: priceMain,
        score: conf,
        confidence: conf,
        expiry_seconds: 60,
        details: {diff}
      };
      io.emit('signal', s);
      console.log('EMIT MATCH', s);
    }
  }
}

// Deriv WS
function connectDeriv() {
  const ws = new WebSocket(DERIV_WS);
  ws.on('open', () => {
    console.log('Deriv WS open');
    if (TOKEN) ws.send(JSON.stringify({ authorize: TOKEN }));
    else {
      console.warn('No DERIV_TOKEN set — using public tick subscribe may be limited.');
      ws.send(JSON.stringify({ ticks: SYMBOL_MAIN }));
      ws.send(JSON.stringify({ ticks: SYMBOL_ALT }));
    }
  });
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.authorize) {
        console.log('Authorized');
        ws.send(JSON.stringify({ ticks: SYMBOL_MAIN }));
        ws.send(JSON.stringify({ ticks: SYMBOL_ALT }));
        return;
      }
      if (data.error) {
        console.error('Deriv error', data.error);
      }
      if (data.tick) {
        const symbol = data.tick.symbol || SYMBOL_MAIN; // fallback
        const price = Number(data.tick.quote);
        const ts = data.tick.epoch * 1000;
        if (symbol === SYMBOL_ALT) {
          pushBuf(bufAlt, price);
        } else {
          // treat as main if unknown
          pushBuf(bufMain, price);
        }
        // emit tick
        io.emit('tick', {ts, price, symbol});
        // try emit signals from main price
        maybeEmitSignals(price);
      }
    } catch (e) {
      console.error('WS parse error', e);
    }
  });
  ws.on('close', () => {
    console.log('Deriv WS closed — reconnect 3s');
    setTimeout(connectDeriv, 3000);
  });
  ws.on('error', (err) => console.error('Deriv WS error', err));
  return ws;
}

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  console.log('client connected', socket.id);
  socket.emit('hello', {now: Date.now()});
  socket.on('disconnect', ()=> console.log('client disconnected', socket.id));
});

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
  connectDeriv();
});
