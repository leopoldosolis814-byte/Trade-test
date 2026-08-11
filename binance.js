import crypto from 'crypto';

function firmar(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

// ============================================================
// CÁLCULO DE INDICADORES TÉCNICOS REALES
// ============================================================
function calcularEMA(closes, periodo) {
  const k = 2 / (periodo + 1);
  let ema = closes.slice(0, periodo).reduce((a, b) => a + b, 0) / periodo;
  for (let i = periodo; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcularRSI(closes, periodo = 14) {
  let ganancias = 0, perdidas = 0;
  for (let i = closes.length - periodo; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) ganancias += diff;
    else perdidas -= diff;
  }
  const avgGain = ganancias / periodo;
  const avgLoss = perdidas / periodo;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcularMACD(closes) {
  const ema12 = calcularEMA(closes, 12);
  const ema26 = calcularEMA(closes, 26);
  const macdLine = ema12 - ema26;
  return { macdLine, tendencia: macdLine > 0 ? 'alcista' : 'bajista' };
}

function calcularIndicadores(closes) {
  const precioActual = closes[closes.length - 1];
  const ema9 = calcularEMA(closes, 9);
  const ema21 = calcularEMA(closes, 21);
  const rsi = calcularRSI(closes, 14);
  const macd = calcularMACD(closes);

  return {
    precio: precioActual,
    ema9: Number(ema9.toFixed(2)),
    ema21: Number(ema21.toFixed(2)),
    rsi: Number(rsi.toFixed(2)),
    macd: Number(macd.macdLine.toFixed(2)),
    macdTendencia: macd.tendencia,
    cruceEMA: ema9 > ema21 ? 'EMA9 sobre EMA21 (alcista)' : 'EMA9 bajo EMA21 (bajista)'
  };
}

function calcularEMASerie(closes, periodo) {
  const k = 2 / (periodo + 1);
  const arr = new Array(closes.length).fill(null);
  let ema = closes.slice(0, periodo).reduce((a, b) => a + b, 0) / periodo;
  arr[periodo - 1] = ema;
  for (let i = periodo; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    arr[i] = ema;
  }
  return arr;
}

// Simula la estrategia "cruce EMA9/EMA21" sobre precios históricos reales
function backtestEMACross(closes, balanceInicial = 10000) {
  const ema9 = calcularEMASerie(closes, 9);
  const ema21 = calcularEMASerie(closes, 21);
  let posicion = null;
  let balance = balanceInicial;
  const trades = [];

  for (let i = 22; i < closes.length; i++) {
    if (ema9[i] == null || ema21[i] == null) continue;
    const cruceArriba = ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i];
    const cruceAbajo = ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i];

    if (!posicion && cruceArriba) {
      posicion = { entryPrice: closes[i] };
    } else if (posicion && cruceAbajo) {
      const pnlPct = (closes[i] - posicion.entryPrice) / posicion.entryPrice;
      balance = balance * (1 + pnlPct);
      trades.push({ entrada: Number(posicion.entryPrice.toFixed(2)), salida: Number(closes[i].toFixed(2)), pnlPct: Number((pnlPct * 100).toFixed(2)) });
      posicion = null;
    }
  }

  const ganadas = trades.filter(t => t.pnlPct > 0).length;
  return {
    balanceInicial,
    balanceFinal: Number(balance.toFixed(2)),
    retornoTotalPct: Number(((balance - balanceInicial) / balanceInicial * 100).toFixed(2)),
    totalOperaciones: trades.length,
    ganadas,
    perdidas: trades.length - ganadas,
    winRate: trades.length ? Number((ganadas / trades.length * 100).toFixed(1)) : 0,
    ultimasOperaciones: trades.slice(-10)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_KEY = process.env.BINANCE_API_KEY?.trim();
  const SECRET_KEY = process.env.BINANCE_SECRET_KEY?.trim();
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const BASE = 'https://testnet.binance.vision';

  try {
    const action = req.query.action || (req.body && req.body.action);
    const symbol = (req.method === 'GET' ? req.query.symbol : req.body?.symbol) || 'BTCUSDT';

    // ============================================================
    // TEST - Ping simple (no necesita firma)
    // ============================================================
    if (action === 'debug') {
      return res.json({
        apiKeyLength: API_KEY ? API_KEY.length : 0,
        apiKeyPreview: API_KEY ? `${API_KEY.slice(0,4)}...${API_KEY.slice(-4)}` : null,
        secretKeyLength: SECRET_KEY ? SECRET_KEY.length : 0,
        groqKeyLength: GROQ_KEY ? GROQ_KEY.length : 0,
        groqKeyPreview: GROQ_KEY ? `${GROQ_KEY.slice(0,4)}...${GROQ_KEY.slice(-4)}` : null
      });
    }

    if (action === 'test') {
      if (!API_KEY || !SECRET_KEY) {
        return res.json({ success: false, error: 'API keys de Binance no configuradas en Vercel' });
      }

      const testResponse = await fetch(`${BASE}/api/v3/ping`, {
        headers: { 'X-MBX-APIKEY': API_KEY }
      });

      if (!testResponse.ok) {
        const bodyText = await testResponse.text().catch(() => '');
        return res.json({
          success: false,
          message: '❌ Error de conexión',
          debug_status: testResponse.status,
          debug_body: bodyText
        });
      }

      return res.json({ success: true, message: '✅ Conectado a Binance Testnet' });
    }

    // ============================================================
    // PRICE - Público, no necesita firma
    // ============================================================
    if (action === 'price') {
      const priceResponse = await fetch(`${BASE}/api/v3/ticker/price?symbol=${symbol}`);

      if (!priceResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo precio' });
      }

      const priceData = await priceResponse.json();
      return res.json({ success: true, price: priceData.price });
    }

    // ============================================================
    // BACKTEST - Simula la estrategia contra el historial real de precios
    // ============================================================
    if (action === 'backtest') {
      const interval = req.query.interval || '1h';
      const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

      const klinesResponse = await fetch(
        `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      );

      if (!klinesResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo velas' });
      }

      const klines = await klinesResponse.json();
      const closes = klines.map(k => parseFloat(k[4]));
      const resultado = backtestEMACross(closes);

      return res.json({ success: true, symbol, interval, velasAnalizadas: closes.length, estrategia: 'Cruce EMA9/EMA21', ...resultado });
    }

      const interval = req.query.interval || '1h';
      const klinesResponse = await fetch(
        `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`
      );

      if (!klinesResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo velas' });
      }

      const klines = await klinesResponse.json();
      const closes = klines.map(k => parseFloat(k[4]));

      const result = calcularIndicadores(closes);
      return res.json({ success: true, symbol, interval, ...result });
    }

    // ============================================================
    // BALANCE - Privado, necesita firma
    // ============================================================
    if (action === 'balance') {
      if (!API_KEY || !SECRET_KEY) {
        return res.status(400).json({ error: 'Binance keys no configuradas' });
      }

      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = firmar(query, SECRET_KEY);

      const balanceResponse = await fetch(
        `${BASE}/api/v3/account?${query}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': API_KEY } }
      );

      if (!balanceResponse.ok) {
        const errData = await balanceResponse.json().catch(() => ({}));
        return res.status(500).json({ error: errData.msg || 'Error obteniendo saldo' });
      }

      const balanceData = await balanceResponse.json();
      const usdtBalance = balanceData.balances?.find(b => b.asset === 'USDT');

      return res.json({ success: true, balance: usdtBalance?.free || 0 });
    }

    // ============================================================
    // ORDER - Privado, necesita firma
    // ============================================================
    if (action === 'order') {
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Método no permitido' });
      }

      if (!API_KEY || !SECRET_KEY) {
        return res.status(400).json({ success: false, error: 'Binance keys no configuradas' });
      }

      const { side, quantity } = req.body;

      if (!side || !quantity) {
        return res.status(400).json({ success: false, error: 'Faltan side o quantity' });
      }

      const timestamp = Date.now();
      const query = `symbol=BTCUSDT&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
      const signature = firmar(query, SECRET_KEY);

      const orderResponse = await fetch(
        `${BASE}/api/v3/order?${query}&signature=${signature}`,
        { method: 'POST', headers: { 'X-MBX-APIKEY': API_KEY } }
      );

      const orderData = await orderResponse.json();

      if (orderResponse.ok) {
        return res.json({ success: true, order: orderData });
      } else {
        return res.json({ success: false, error: orderData.msg || 'Orden falló' });
      }
    }

    // ============================================================
    // CHAT - Groq
    // ============================================================
    if (action === 'chat') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
      }

      if (!GROQ_KEY) {
        return res.status(400).json({ error: 'Groq API key no configurada en Vercel', fallback: true });
      }

      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'Mensaje vacío' });
      }

      // Traer indicadores reales de BTC para que el agente responda con datos concretos
      let contextoMercado = '';
      try {
        const klinesResponse = await fetch(`${BASE}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100`);
        if (klinesResponse.ok) {
          const klines = await klinesResponse.json();
          const closes = klines.map(k => parseFloat(k[4]));
          const ind = calcularIndicadores(closes);
          contextoMercado = `\n\nDatos actuales de BTC/USDT (Binance Testnet, vela 1h):
Precio: $${ind.precio}
RSI(14): ${ind.rsi}
EMA9: $${ind.ema9} | EMA21: $${ind.ema21} (${ind.cruceEMA})
MACD: ${ind.macd} (tendencia ${ind.macdTendencia})
Usá estos datos reales si la pregunta es sobre el mercado o BTC. Si la pregunta no tiene que ver con esto, ignoralos.`;
        }
      } catch (e) {
        // Si falla traer indicadores, seguimos sin ellos
      }

      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [
              { role: 'system', content: 'Eres un asistente de trading profesional. Respondes en español de forma clara, breve y estructurada. Nunca das certezas sobre el futuro del precio, solo lecturas de probabilidad basadas en los datos que tenés. No ejecutás órdenes, solo sugerís y explicás.' + contextoMercado },
              { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 500
          })
        });

        const data = await groqRes.json();

        if (data.choices && data.choices[0]) {
          return res.json({ success: true, response: data.choices[0].message.content });
        } else {
          return res.json({ success: false, error: data.error?.message || 'Error con Groq', debug_groq: data, fallback: true });
        }
      } catch (error) {
        return res.json({ success: false, error: error.message, fallback: true });
      }
    }

    return res.status(400).json({ success: false, error: 'Acción no válida. Usa: test, price, balance, order, chat' });

  } catch (error) {
    console.error('Error en API:', error);
    return res.status(500).json({ success: false, error: error.message || 'Error interno del servidor' });
  }
}
