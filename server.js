// server.js — Deriv 1-tick prediction server + static frontend
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
const SYMBOL = process.env.SYMBOL || 'R_100'; // change if desired
const TOKEN = process.env.DERIV_TOKEN || '';   // set in Render secrets
const MIN_TICKS = 3;
const MAXBUF = 500;

let prices = [];

function pushPrice(p) {
  prices.push(Number(p));
  if (prices.length > MAXBUF) prices.shift();
}
function sma(n) {
  if (prices.length < n) return null;
  const s = prices.slice(-n).reduce((a,b)=>a+b,0);
  return s / n;
}

// small 1-tick heuristic predictor
function compute1TickPrediction() {
  if (prices.length < MIN_TICKS) return null;
  const p0 = prices[prices.length-1];
  const p1 = prices[prices.length-2];
  const p2 = prices[prices.length-3];

  const momentum = (p0 - p1) + 0.5*(p1 - p2);
  const raw = Math.tanh(momentum / Math.max(1, Math.abs(p0)/1000 + 1e-9));
  const confidence = Math.max(0.01, Math.min(0.99, 0.5 + raw*0.5));
  const overUnderDirection = momentum >= 0 ? 'over' : 'under';

  const lastDigit = Math.floor(p0) % 10;
  const parity = (lastDigit % 2 === 0) ? 'even' : 'odd';
  const parityConf = Math.min(0.99, 0.5 + ( [0,2,4,6,8].includes(lastDigit) ? 0.05 : 0 ));

  return {
    ts: Date.now(),
    price: p0,
    over_under: { direction: overUnderDirection, confidence: Number(confidence.toFixed(3)), momentum },
    even_odd: { direction: parity, confidence: Number(parityConf.toFixed(3)) }
  };
}

// connect to Deriv Websocket
function connectDeriv() {
  const ws = new WebSocket(DERIV_WS);
  ws.on('open', () => {
    console.log('Deriv WS open — subscribing', SYMBOL);
    if (TOKEN) ws.send(JSON.stringify({ authorize: TOKEN }));
    else ws.send(JSON.stringify({ ticks: SYMBOL }));
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.authorize) {
        console.log('Authorized — subscribing', SYMBOL);
        ws.send(JSON.stringify({ ticks: SYMBOL }));
        return;
      }
      if (data.error) {
        console.error('Deriv error', data.error);
      }
      if (data.tick && typeof data.tick.quote !== 'undefined') {
        const price = Number(data.tick.quote);
        pushPrice(price);
        io.emit('tick', { ts: data.tick.epoch * 1000, price, symbol: data.tick.symbol || SYMBOL });

        const pred = compute1TickPrediction();
        if (pred) {
          const payload = {
            id: 'sig_' + Date.now(),
            ts: Date.now(),
            type: '1_tick_prediction',
            market: SYMBOL,
            price: pred.price,
            predictions: { over_under: pred.over_under, even_odd: pred.even_odd },
            expiry_seconds: 1
          };
          io.emit('signal', payload);
          console.log('EMIT signal', payload.market, payload.price, payload.predictions.over_under.direction, Math.round(payload.predictions.over_under.confidence*100)+'%');
        }
      }
    } catch (e) {
      console.error('WS parse error', e);
    }
  });

  ws.on('close', () => {
    console.log('Deriv WS closed — reconnect in 3s');
    setTimeout(connectDeriv, 3000);
  });
  ws.on('error', (err) => console.error('Deriv WS error', err));
}

io.on('connection', socket => {
  console.log('client connected', socket.id);
  socket.emit('hello', { now: Date.now(), last_price: prices[prices.length-1] || null });
});

// health and static
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
  connectDeriv();
}); 
