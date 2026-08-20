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

// VWAP (precio promedio ponderado por volumen) y volumen — los indicadores que de verdad
// se usan en timeframes cortos (scalping), a diferencia de RSI/EMA que están pensados
// para suavizar ruido en velas más largas.
function calcularVWAP(highs, lows, closes, volumes) {
  let sumaPV = 0, sumaV = 0;
  for (let i = 0; i < closes.length; i++) {
    const precioTipico = (highs[i] + lows[i] + closes[i]) / 3;
    sumaPV += precioTipico * volumes[i];
    sumaV += volumes[i];
  }
  return sumaV > 0 ? sumaPV / sumaV : closes[closes.length - 1];
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

function calcularRSISerie(closes, periodo = 14) {
  const arr = new Array(closes.length).fill(null);
  for (let i = periodo; i < closes.length; i++) {
    let ganancias = 0, perdidas = 0;
    for (let j = i - periodo + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff >= 0) ganancias += diff;
      else perdidas -= diff;
    }
    const avgGain = ganancias / periodo;
    const avgLoss = perdidas / periodo;
    arr[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return arr;
}

function calcularBollinger(closes, periodo = 20, mult = 2) {
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = periodo - 1; i < closes.length; i++) {
    const slice = closes.slice(i - periodo + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / periodo;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / periodo;
    const std = Math.sqrt(variance);
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { upper, lower };
}

function resumenBacktest(trades, balance, balanceInicial, maxDrawdown, buyHoldPct) {
  const ganadas = trades.filter(t => t.pnlPct > 0).length;
  return {
    balanceInicial,
    balanceFinal: Number(balance.toFixed(2)),
    retornoTotalPct: Number(((balance - balanceInicial) / balanceInicial * 100).toFixed(2)),
    totalOperaciones: trades.length,
    ganadas,
    perdidas: trades.length - ganadas,
    winRate: trades.length ? Number((ganadas / trades.length * 100).toFixed(1)) : 0,
    maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
    buyHoldPct: Number(buyHoldPct.toFixed(2)),
    ultimasOperaciones: trades.slice(-10)
  };
}

// Motor común: aplica comisión + slippage reales, respeta stop-loss/take-profit
// intrabar (usando máximos/mínimos reales de cada vela), y mide drawdown máximo.
function runBacktestEngine(closes, highs, lows, entrySignal, exitSignal, opts = {}) {
  const {
    balanceInicial = 10000,
    comisionPct = 0.001,   // 0.1% por lado, como cobra Binance
    slippagePct = 0.0005,  // 0.05% de deslizamiento estimado por lado
    slPct = 2,             // stop-loss: corta si cae 2% desde la entrada
    tpPct = 4               // take-profit: toma ganancia si sube 4% desde la entrada
  } = opts;

  let balance = balanceInicial;
  let posicion = null;
  let peakBalance = balance;
  let maxDrawdown = 0;
  const trades = [];

  for (let i = 1; i < closes.length; i++) {
    if (posicion) {
      const slPrice = posicion.entryPrice * (1 - slPct / 100);
      const tpPrice = posicion.entryPrice * (1 + tpPct / 100);
      let salida = null, motivo = 'señal';

      if (lows[i] <= slPrice) { salida = slPrice; motivo = 'stop-loss'; }
      else if (highs[i] >= tpPrice) { salida = tpPrice; motivo = 'take-profit'; }
      else if (exitSignal(i)) { salida = closes[i]; motivo = 'señal'; }

      if (salida != null) {
        const entryEff = posicion.entryPrice * (1 + comisionPct + slippagePct);
        const exitEff = salida * (1 - comisionPct - slippagePct);
        const pnlPct = (exitEff - entryEff) / entryEff;
        balance *= (1 + pnlPct);
        trades.push({
          entrada: Number(posicion.entryPrice.toFixed(2)),
          salida: Number(salida.toFixed(2)),
          pnlPct: Number((pnlPct * 100).toFixed(2)),
          motivo
        });
        posicion = null;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, (peakBalance - balance) / peakBalance * 100);
      }
    } else if (entrySignal(i)) {
      posicion = { entryPrice: closes[i] };
    }
  }

  const buyHoldPct = (closes[closes.length - 1] - closes[0]) / closes[0] * 100;
  return resumenBacktest(trades, balance, balanceInicial, maxDrawdown, buyHoldPct);
}

// ESTRATEGIA 1: Cruce EMA (parametrizable: rápida/lenta)
function backtestEMACrossParam(closes, highs, lows, opts = {}, fast = 9, slow = 21) {
  const emaFast = calcularEMASerie(closes, fast);
  const emaSlow = calcularEMASerie(closes, slow);
  const entry = i => emaFast[i - 1] != null && emaSlow[i - 1] != null && emaFast[i - 1] <= emaSlow[i - 1] && emaFast[i] > emaSlow[i];
  const exit = i => emaFast[i - 1] != null && emaSlow[i - 1] != null && emaFast[i - 1] >= emaSlow[i - 1] && emaFast[i] < emaSlow[i];
  return runBacktestEngine(closes, highs, lows, entry, exit, opts);
}
function backtestEMACross(closes, highs, lows, opts = {}) {
  return backtestEMACrossParam(closes, highs, lows, opts, 9, 21);
}

// ESTRATEGIA 2: RSI en extremos (parametrizable: período/umbrales)
function backtestRSIParam(closes, highs, lows, opts = {}, periodo = 14, oversold = 30, overbought = 70) {
  const rsi = calcularRSISerie(closes, periodo);
  const entry = i => rsi[i] != null && rsi[i] < oversold;
  const exit = i => rsi[i] != null && rsi[i] > overbought;
  return runBacktestEngine(closes, highs, lows, entry, exit, opts);
}
function backtestRSIExtremos(closes, highs, lows, opts = {}) {
  return backtestRSIParam(closes, highs, lows, opts, 14, 30, 70);
}

// ESTRATEGIA 3: Bandas de Bollinger (parametrizable: período/multiplicador)
function backtestBollingerParam(closes, highs, lows, opts = {}, periodo = 20, mult = 2) {
  const { upper, lower } = calcularBollinger(closes, periodo, mult);
  const entry = i => lower[i] != null && closes[i] < lower[i];
  const exit = i => upper[i] != null && closes[i] > upper[i];
  return runBacktestEngine(closes, highs, lows, entry, exit, opts);
}
function backtestBollinger(closes, highs, lows, opts = {}) {
  return backtestBollingerParam(closes, highs, lows, opts, 20, 2);
}

// ESTRATEGIA 4: Confluencia — compra solo si RSI bajo Y tendencia EMA alcista a la vez
function backtestConfluencia(closes, highs, lows, opts = {}, fast = 9, slow = 21, oversold = 35, overbought = 65) {
  const emaFast = calcularEMASerie(closes, fast);
  const emaSlow = calcularEMASerie(closes, slow);
  const rsi = calcularRSISerie(closes, 14);
  const entry = i => emaFast[i] != null && emaSlow[i] != null && rsi[i] != null && emaFast[i] > emaSlow[i] && rsi[i] < oversold;
  const exit = i => rsi[i] != null && (rsi[i] > overbought || (emaFast[i] != null && emaSlow[i] != null && emaFast[i] < emaSlow[i]));
  return runBacktestEngine(closes, highs, lows, entry, exit, opts);
}

// ESTRATEGIA 5: Trend Following — entra cuando rompe el máximo reciente (confirma tendencia
// nueva), y en vez de tomar ganancia fija, deja correr con un stop que sube detrás del precio
// (trailing stop). Filosofía opuesta a la reversión: "dejar correr las ganancias".
function backtestTrendFollowing(closes, highs, lows, opts = {}, breakoutPeriod = 20, trailingPct = 5) {
  const balanceInicial = opts.balanceInicial || 10000;
  const comisionPct = opts.comisionPct ?? 0.001;
  const slippagePct = opts.slippagePct ?? 0.0005;
  const slPct = opts.slPct ?? 2;
  let balance = balanceInicial, posicion = null, peakBalance = balance, maxDrawdown = 0;
  const trades = [];

  for (let i = breakoutPeriod; i < closes.length; i++) {
    if (!posicion) {
      const maxReciente = Math.max(...highs.slice(i - breakoutPeriod, i));
      if (closes[i] > maxReciente) {
        posicion = { entryPrice: closes[i], maxDesdeEntrada: closes[i] };
      }
    } else {
      posicion.maxDesdeEntrada = Math.max(posicion.maxDesdeEntrada, highs[i]);
      const stopInicial = posicion.entryPrice * (1 - slPct / 100);
      const trailingStop = posicion.maxDesdeEntrada * (1 - trailingPct / 100);
      const stopActivo = Math.max(stopInicial, trailingStop);

      if (lows[i] <= stopActivo) {
        const entryEff = posicion.entryPrice * (1 + comisionPct + slippagePct);
        const exitEff = stopActivo * (1 - comisionPct - slippagePct);
        const pnlPct = (exitEff - entryEff) / entryEff;
        balance *= (1 + pnlPct);
        trades.push({
          entrada: Number(posicion.entryPrice.toFixed(2)),
          salida: Number(stopActivo.toFixed(2)),
          pnlPct: Number((pnlPct * 100).toFixed(2)),
          motivo: stopActivo === stopInicial ? 'stop-loss' : 'trailing-stop'
        });
        posicion = null;
        peakBalance = Math.max(peakBalance, balance);
        maxDrawdown = Math.max(maxDrawdown, (peakBalance - balance) / peakBalance * 100);
      }
    }
  }
  const buyHoldPct = (closes[closes.length - 1] - closes[0]) / closes[0] * 100;
  return resumenBacktest(trades, balance, balanceInicial, maxDrawdown, buyHoldPct);
}

// ESTRATEGIA 6: Breakout — compra al romper el máximo de las últimas N velas (canal Donchian),
// vende al romper el mínimo. Prima cercana de Trend Following, con salida más rápida.
function backtestBreakout(closes, highs, lows, opts = {}, periodo = 20) {
  const donchianHigh = new Array(closes.length).fill(null);
  const donchianLow = new Array(closes.length).fill(null);
  for (let i = periodo; i < closes.length; i++) {
    donchianHigh[i] = Math.max(...highs.slice(i - periodo, i));
    donchianLow[i] = Math.min(...lows.slice(i - periodo, i));
  }
  const entry = i => donchianHigh[i] != null && closes[i] > donchianHigh[i];
  const exit = i => donchianLow[i] != null && closes[i] < donchianLow[i];
  return runBacktestEngine(closes, highs, lows, entry, exit, opts);
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
  const REAL_BASE = 'https://api.binance.com'; // Solo lectura pública (precios/velas reales), nunca para órdenes

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
    // BACKTEST - Simula estrategias contra el historial REAL de Binance
    // ============================================================
    if (action === 'backtest') {
      const interval = req.query.interval || '1h';
      const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
      const strategy = req.query.strategy || 'ema_cross';
      const slPct = parseFloat(req.query.sl) || 2;
      const tpPct = parseFloat(req.query.tp) || 4;

      const klinesResponse = await fetch(
        `${REAL_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      );

      if (!klinesResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo velas reales' });
      }

      const klines = await klinesResponse.json();
      const closes = klines.map(k => parseFloat(k[4]));
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const opts = { slPct, tpPct };

      const estrategias = {
        ema_cross: { nombre: 'Cruce EMA9/EMA21', fn: backtestEMACross },
        rsi_extremos: { nombre: 'RSI en extremos (30/70)', fn: backtestRSIExtremos },
        bollinger: { nombre: 'Bandas de Bollinger', fn: backtestBollinger },
        confluencia: { nombre: 'Confluencia RSI+EMA', fn: backtestConfluencia },
        trend_following: { nombre: 'Trend Following (ruptura + trailing stop)', fn: backtestTrendFollowing },
        breakout: { nombre: 'Breakout (canal Donchian)', fn: backtestBreakout }
      };

      if (strategy === 'todas') {
        const resultados = {};
        for (const [key, { nombre, fn }] of Object.entries(estrategias)) {
          resultados[key] = { estrategia: nombre, ...fn(closes, highs, lows, opts) };
        }
        return res.json({ success: true, symbol, interval, velasAnalizadas: closes.length, slPct, tpPct, comparacion: resultados });
      }

      const elegida = estrategias[strategy];
      if (!elegida) {
        return res.status(400).json({ error: 'Estrategia no válida. Usa: ema_cross, rsi_extremos, bollinger, todas' });
      }

      const resultado = elegida.fn(closes, highs, lows, opts);
      return res.json({ success: true, symbol, interval, velasAnalizadas: closes.length, slPct, tpPct, estrategia: elegida.nombre, ...resultado });
    }

    // ============================================================
    // OPTIMIZE - Prueba varias combinaciones de parámetros, elige la mejor
    // en la primera mitad del historial, y la valida en la segunda mitad
    // (datos que no vio al elegir) para evitar sobreajuste.
    // ============================================================
    if (action === 'optimize') {
      const interval = req.query.interval || '4h';
      const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
      const strategy = req.query.strategy || 'rsi_extremos';
      const slPct = parseFloat(req.query.sl) || 2;
      const tpPct = parseFloat(req.query.tp) || 4;
      const opts = { slPct, tpPct };

      const klinesResponse = await fetch(
        `${REAL_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      );
      if (!klinesResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo velas reales' });
      }

      const klines = await klinesResponse.json();
      const closes = klines.map(k => parseFloat(k[4]));
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));

      const mid = Math.floor(closes.length / 2);
      const inS = { closes: closes.slice(0, mid), highs: highs.slice(0, mid), lows: lows.slice(0, mid) };
      const outS = { closes: closes.slice(mid), highs: highs.slice(mid), lows: lows.slice(mid) };

      let combos = [];
      if (strategy === 'rsi_extremos') {
        for (const periodo of [10, 14, 21]) for (const oversold of [20, 25, 30]) for (const overbought of [70, 75, 80]) {
          combos.push({ params: { periodo, oversold, overbought }, fn: (c, h, l, o) => backtestRSIParam(c, h, l, o, periodo, oversold, overbought) });
        }
      } else if (strategy === 'ema_cross') {
        for (const fast of [5, 9, 12]) for (const slow of [21, 26, 34]) {
          if (fast >= slow) continue;
          combos.push({ params: { fast, slow }, fn: (c, h, l, o) => backtestEMACrossParam(c, h, l, o, fast, slow) });
        }
      } else if (strategy === 'bollinger') {
        for (const periodo of [15, 20, 25]) for (const mult of [1.5, 2, 2.5]) {
          combos.push({ params: { periodo, mult }, fn: (c, h, l, o) => backtestBollingerParam(c, h, l, o, periodo, mult) });
        }
      } else if (strategy === 'confluencia') {
        for (const oversold of [30, 35, 40]) for (const overbought of [60, 65, 70]) {
          combos.push({ params: { oversold, overbought }, fn: (c, h, l, o) => backtestConfluencia(c, h, l, o, 9, 21, oversold, overbought) });
        }
      } else if (strategy === 'trend_following') {
        for (const breakoutPeriod of [10, 20, 30]) for (const trailingPct of [3, 5, 8]) {
          combos.push({ params: { breakoutPeriod, trailingPct }, fn: (c, h, l, o) => backtestTrendFollowing(c, h, l, o, breakoutPeriod, trailingPct) });
        }
      } else if (strategy === 'breakout') {
        for (const periodo of [10, 20, 30]) {
          combos.push({ params: { periodo }, fn: (c, h, l, o) => backtestBreakout(c, h, l, o, periodo) });
        }
      } else {
        return res.status(400).json({ error: 'Estrategia no válida. Usa: rsi_extremos, ema_cross, bollinger, confluencia, trend_following, breakout' });
      }

      const MIN_OPERACIONES = 8; // evita elegir "ganadores" con muestras chicas (ej: 2 de 2)
      let mejor = null;
      const resultadosInSample = [];
      for (const combo of combos) {
        const r = combo.fn(inS.closes, inS.highs, inS.lows, opts);
        resultadosInSample.push({ params: combo.params, retornoTotalPct: r.retornoTotalPct, winRate: r.winRate, operaciones: r.totalOperaciones });
        const cumpleMinimo = r.totalOperaciones >= MIN_OPERACIONES;
        if (cumpleMinimo && (!mejor || r.retornoTotalPct > mejor.resultado.retornoTotalPct)) {
          mejor = { params: combo.params, fn: combo.fn, resultado: r };
        }
      }

      if (!mejor) {
        resultadosInSample.sort((a, b) => b.operaciones - a.operaciones);
        return res.json({
          success: true,
          symbol, interval, strategy,
          totalCombinacionesProbadas: combos.length,
          advertencia: `Ninguna combinación alcanzó el mínimo de ${MIN_OPERACIONES} operaciones en la primera mitad — no hay muestra suficiente para elegir con confianza. Probá con más velas (limit mayor) o un intervalo más largo.`,
          top5InSample: resultadosInSample.slice(0, 5)
        });
      }

      // Valida el mejor combo en datos que NO vio al elegir — esto es lo que importa de verdad
      const outSampleResult = mejor.fn(outS.closes, outS.highs, outS.lows, opts);
      resultadosInSample.sort((a, b) => b.retornoTotalPct - a.retornoTotalPct);

      return res.json({
        success: true,
        symbol, interval, strategy,
        totalCombinacionesProbadas: combos.length,
        mejorParametros: mejor.params,
        inSample: mejor.resultado,
        outSample: outSampleResult,
        top5InSample: resultadosInSample.slice(0, 5)
      });
    }

    // ============================================================
    // INDICATORS - Indicadores técnicos reales calculados sobre velas de Binance
    // ============================================================
    // ============================================================
    // GUIDED_ANALYSIS - Panel de análisis guiado: junta indicadores reales,
    // arma un checklist de confluencia, calcula entry/SL/TP y tamaño de riesgo,
    // y le pide a Groq una explicación en base a esos datos (no inventa nada).
    // ============================================================
    if (action === 'guided_analysis') {
      const interval = req.query.interval || '1h';
      const slPct = parseFloat(req.query.sl) || 2;
      const tpPct = parseFloat(req.query.tp) || 4;

      const klinesResponse = await fetch(`${REAL_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`);
      if (!klinesResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo velas reales' });
      }
      const klines = await klinesResponse.json();
      const closes = klines.map(k => parseFloat(k[4]));
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const volumes = klines.map(k => parseFloat(k[5]));

      const ind = calcularIndicadores(closes);
      const vwap = calcularVWAP(highs, lows, closes, volumes);
      const { upper, lower } = calcularBollinger(closes, 20, 2);
      const i = closes.length - 1;
      const precio = closes[i];

      const checklist = [
        { name: 'RSI(14)', desc: `RSI en ${ind.rsi} — ${ind.rsi < 40 ? 'zona de sobreventa, favorable a compra' : ind.rsi > 60 ? 'zona de sobrecompra, favorable a venta' : 'zona neutral, sin señal clara'}`, favor: ind.rsi < 40 ? 'BUY' : ind.rsi > 60 ? 'SELL' : 'NEUTRAL' },
        { name: 'Tendencia EMA9/21', desc: ind.cruceEMA, favor: ind.ema9 > ind.ema21 ? 'BUY' : 'SELL' },
        { name: 'MACD', desc: `${ind.macd} (tendencia ${ind.macdTendencia})`, favor: ind.macdTendencia === 'alcista' ? 'BUY' : 'SELL' },
        { name: 'Bandas de Bollinger', desc: precio < lower[i] ? 'Precio bajo la banda inferior (sobreventa)' : precio > upper[i] ? 'Precio sobre la banda superior (sobrecompra)' : 'Precio dentro de las bandas, sin extremo', favor: precio < lower[i] ? 'BUY' : precio > upper[i] ? 'SELL' : 'NEUTRAL' },
        { name: 'VWAP', desc: `Precio $${precio.toFixed(2)} vs VWAP $${vwap.toFixed(2)} — ${precio < vwap ? 'por debajo (favorable a compra)' : 'por encima (favorable a venta)'}`, favor: precio < vwap ? 'BUY' : 'SELL' }
      ];

      const votosBuy = checklist.filter(c => c.favor === 'BUY').length;
      const votosSell = checklist.filter(c => c.favor === 'SELL').length;
      let accion = 'WAIT';
      if (votosBuy > votosSell && votosBuy >= 3) accion = 'BUY';
      else if (votosSell > votosBuy && votosSell >= 3) accion = 'SELL';
      const confidence = Math.round((Math.max(votosBuy, votosSell) / checklist.length) * 100);

      const entry = precio;
      const sl = accion === 'SELL' ? entry * (1 + slPct / 100) : entry * (1 - slPct / 100);
      const tp = accion === 'SELL' ? entry * (1 - tpPct / 100) : entry * (1 + tpPct / 100);

      let explicacion = `${votosBuy} de ${checklist.length} indicadores favorecen compra, ${votosSell} favorecen venta. Sin certezas del futuro, esto es una lectura de probabilidad, no una garantía.`;
      try {
        if (GROQ_KEY) {
          const resumenChecklist = checklist.map(c => `- ${c.name}: ${c.desc}`).join('\n');
          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [
                { role: 'system', content: `Sos un asistente de trading. Con los datos reales que te paso, explicá en 2-3 frases en español por qué la señal calculada es ${accion}, mencionando qué indicadores coinciden y cuáles no. Nunca des certezas del futuro, solo lectura de probabilidad.\n\nDatos reales:\n${resumenChecklist}\n\nAcción calculada: ${accion} (confianza ${confidence}%, ${votosBuy} a favor de compra, ${votosSell} a favor de venta, de ${checklist.length} indicadores)` },
                { role: 'user', content: 'Explicá el análisis' }
              ],
              temperature: 0.6, max_tokens: 250
            })
          });
          const gdata = await groqRes.json();
          if (gdata.choices && gdata.choices[0]) explicacion = gdata.choices[0].message.content;
        }
      } catch (e) { /* usamos el fallback ya definido arriba */ }

      return res.json({
        success: true, symbol, interval,
        action: accion, confidence,
        entry: Number(entry.toFixed(2)), sl: Number(sl.toFixed(2)), tp: Number(tp.toFixed(2)),
        slPct, tpPct,
        checklist,
        explicacion
      });
    }

    if (action === 'indicators') {
      const interval = req.query.interval || '1h';
      const limitVelas = Math.min(parseInt(req.query.limit) || 100, 200);
      const klinesResponse = await fetch(
        `${REAL_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limitVelas}`
      );

      if (!klinesResponse.ok) {
        return res.status(500).json({ error: 'Error obteniendo velas' });
      }

      const klines = await klinesResponse.json();
      const closes = klines.map(k => parseFloat(k[4]));
      const highs = klines.map(k => parseFloat(k[2]));
      const lows = klines.map(k => parseFloat(k[3]));
      const volumes = klines.map(k => parseFloat(k[5]));

      const result = calcularIndicadores(closes);
      const vwap = calcularVWAP(highs, lows, closes, volumes);
      const volumenActual = volumes[volumes.length - 1];
      const volumenPromedio = volumes.reduce((a, b) => a + b, 0) / volumes.length;

      let change24h = null;
      try {
        const tickerResp = await fetch(`${REAL_BASE}/api/v3/ticker/24hr?symbol=${symbol}`);
        if (tickerResp.ok) {
          const t = await tickerResp.json();
          change24h = parseFloat(t.priceChangePercent);
        }
      } catch (e) { /* seguimos sin el dato de 24h si falla */ }

      return res.json({
        success: true, symbol, interval, ...result, change24h,
        vwap: Number(vwap.toFixed(2)),
        volumenActual: Number(volumenActual.toFixed(2)),
        volumenPromedio: Number(volumenPromedio.toFixed(2))
      });
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

      const { message, symbols } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'Mensaje vacío' });
      }

      // Si piden comparar varios activos, traemos indicadores de todos en paralelo
      if (Array.isArray(symbols) && symbols.length > 0) {
        let contextoMulti = `\n\nComparación de indicadores reales (Binance, vela 1h) para los activos pedidos:\n`;
        try {
          const resultados = await Promise.all(symbols.slice(0, 8).map(async (sym) => {
            const r = await fetch(`${REAL_BASE}/api/v3/klines?symbol=${sym}&interval=1h&limit=100`);
            if (!r.ok) return null;
            const klines = await r.json();
            const closes = klines.map(k => parseFloat(k[4]));
            return { sym, ind: calcularIndicadores(closes) };
          }));
          for (const res2 of resultados) {
            if (!res2) continue;
            contextoMulti += `- ${res2.sym}: precio $${res2.ind.precio}, RSI ${res2.ind.rsi}, ${res2.ind.cruceEMA}, MACD ${res2.ind.macdTendencia}\n`;
          }
        } catch (e) {
          contextoMulti += '(no se pudieron traer todos los activos)\n';
        }

        try {
          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [
                { role: 'system', content: `Eres un asistente de trading profesional. Respondés en español, breve y estructurado. Comparás los activos pedidos usando SOLO los datos reales que te paso, sin inventar. Nunca das certezas del futuro, solo lecturas de probabilidad. No ejecutás órdenes.${contextoMulti}` },
                { role: 'user', content: message }
              ],
              temperature: 0.7,
              max_tokens: 600
            })
          });
          const data = await groqRes.json();
          if (data.choices && data.choices[0]) {
            return res.json({ success: true, response: data.choices[0].message.content });
          }
          return res.json({ success: false, error: data.error?.message || 'Error con Groq', fallback: true });
        } catch (e) {
          return res.json({ success: false, error: e.message, fallback: true });
        }
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
MACD: ${ind.macd} (tendencia ${ind.macdTendencia})`;
        }
      } catch (e) {
        // Si falla traer indicadores, seguimos sin ellos
      }

      // Resultados reales de backtesting, para que el agente responda con evidencia,
      // no con opinión genérica, si preguntan qué estrategia conviene.
      try {
        const klinesResponse2 = await fetch(`${REAL_BASE}/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=300`);
        if (klinesResponse2.ok) {
          const klines2 = await klinesResponse2.json();
          const closes2 = klines2.map(k => parseFloat(k[4]));
          const highs2 = klines2.map(k => parseFloat(k[2]));
          const lows2 = klines2.map(k => parseFloat(k[3]));

          const estrategiasResumen = [
            { nombre: 'Cruce EMA', r: backtestEMACross(closes2, highs2, lows2) },
            { nombre: 'RSI extremos', r: backtestRSIExtremos(closes2, highs2, lows2) },
            { nombre: 'Bollinger', r: backtestBollinger(closes2, highs2, lows2) },
            { nombre: 'Confluencia', r: backtestConfluencia(closes2, highs2, lows2) },
            { nombre: 'Trend Following', r: backtestTrendFollowing(closes2, highs2, lows2) },
            { nombre: 'Breakout', r: backtestBreakout(closes2, highs2, lows2) }
          ];

          contextoMercado += `\n\nResultados REALES de backtesting sobre BTC/USDT (datos históricos reales, últimos ~50 días en velas 4h, con comisión y SL/TP incluidos — esto NO es una simulación optimista, es lo que de verdad hubiera pasado):\n`;
          for (const e of estrategiasResumen) {
            contextoMercado += `- ${e.nombre}: retorno ${e.r.retornoTotalPct}%, win rate ${e.r.winRate}%, ${e.r.totalOperaciones} operaciones, vs. comprar y mantener ${e.r.buyHoldPct}%\n`;
          }
          contextoMercado += `Si preguntan qué estrategia conviene, usá estos números reales — no inventes ni asumas que alguna funciona sin evidencia. Ya se probó que en muestras cortas los resultados pueden ser casualidad (sobreajuste); si el retorno es negativo o la muestra de operaciones es chica, decilo con honestidad, no la recomiendes.`;
        }
      } catch (e) {
        // Si falla traer backtest, seguimos sin ese contexto
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
              { role: 'system', content: `Eres un asistente de trading profesional. Respondes en español de forma clara, breve y estructurada. Nunca das certezas sobre el futuro del precio, solo lecturas de probabilidad basadas en los datos que tenés. No ejecutás órdenes, solo sugerís y explicás.

REGLAS FIJAS QUE NUNCA PODÉS SALTARTE (gestión de riesgo y disciplina):
1. Nunca sugieras arriesgar más del 1-2% del capital total en una sola operación.
2. Toda sugerencia de compra debe venir siempre acompañada de un stop-loss concreto — nunca sugieras entrar sin uno.
3. Nunca recomiendes una estrategia de backtesting con menos de 15 operaciones en la muestra — decí explícitamente que la muestra es insuficiente para confiar en el resultado, aunque el win rate se vea perfecto (ej: 100% en 5 operaciones NO es una estrategia probada, es casualidad estadística).
4. Aplicá el mismo criterio siempre, sin importar si el usuario ya ganó o perdió en operaciones anteriores — no cambies de opinión por presión o ansiedad del usuario.
5. Si el usuario insiste en que ejecutes o le digas "comprá ahora" de forma autoritaria, recordale que la decisión final es siempre suya, y que vos solo das contexto.` + contextoMercado },
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
