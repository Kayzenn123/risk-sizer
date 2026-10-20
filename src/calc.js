'use strict';
/**
 * risk-sizer core: pure position-sizing math for XAUUSD and forex.
 * No I/O here; all functions are deterministic and dependency-free.
 */

const VERSION = '1.0.0';

/**
 * Built-in contract specs. `pip` is the price distance of one pip;
 * `point` is the smallest quoted digit. 1 pip = 10 points on every
 * symbol below (standard 5/3-digit and 2-digit XAUUSD quoting).
 */
const SYMBOLS = {
  XAUUSD: { contractSize: 100,    digits: 2, point: 0.01,   pip: 0.10,   quote: 'USD', label: 'Gold vs US Dollar' },
  EURUSD: { contractSize: 100000, digits: 5, point: 0.00001, pip: 0.0001, quote: 'USD', label: 'Euro vs US Dollar' },
  GBPUSD: { contractSize: 100000, digits: 5, point: 0.00001, pip: 0.0001, quote: 'USD', label: 'Pound vs US Dollar' },
  AUDUSD: { contractSize: 100000, digits: 5, point: 0.00001, pip: 0.0001, quote: 'USD', label: 'Aussie vs US Dollar' },
  NZDUSD: { contractSize: 100000, digits: 5, point: 0.00001, pip: 0.0001, quote: 'USD', label: 'Kiwi vs US Dollar' },
  USDJPY: { contractSize: 100000, digits: 3, point: 0.001,  pip: 0.01,   quote: 'JPY', label: 'US Dollar vs Yen' },
  GBPJPY: { contractSize: 100000, digits: 3, point: 0.001,  pip: 0.01,   quote: 'JPY', label: 'Pound vs Yen' },
  EURJPY: { contractSize: 100000, digits: 3, point: 0.001,  pip: 0.01,   quote: 'JPY', label: 'Euro vs Yen' },
  USDCAD: { contractSize: 100000, digits: 5, point: 0.00001, pip: 0.0001, quote: 'CAD', label: 'US Dollar vs Canadian Dollar' },
  USDCHF: { contractSize: 100000, digits: 5, point: 0.00001, pip: 0.0001, quote: 'CHF', label: 'US Dollar vs Swiss Franc' },
};

const LOT_STEP = 0.01;
const MIN_LOT = 0.01;

function getSymbol(name) {
  const key = String(name || '').toUpperCase();
  const spec = SYMBOLS[key];
  if (!spec) {
    const known = Object.keys(SYMBOLS).join(', ');
    throw usageError(`unknown symbol "${name}". Known symbols: ${known}. ` +
      `Use --contract-size/--digits/--pip/--quote for a custom symbol.`);
  }
  return { name: key, ...spec };
}

/** Custom symbol override: lets users price anything not built in. */
function customSymbol({ contractSize, digits, pip, quote }) {
  if (!(contractSize > 0)) throw usageError('--contract-size must be a positive number');
  if (!(digits >= 0 && Number.isInteger(digits))) throw usageError('--digits must be a non-negative integer');
  const point = 1 / Math.pow(10, digits);
  const pipSize = pip !== undefined ? pip : point * 10;
  if (!(pipSize > 0)) throw usageError('--pip must be a positive number');
  if (!quote || !/^[A-Z]{3}$/i.test(quote)) throw usageError('--quote must be a 3-letter currency code');
  return { name: 'CUSTOM', contractSize, digits, point, pip: pipSize, quote: quote.toUpperCase(), label: 'Custom symbol' };
}

class UsageError extends Error {
  constructor(message) { super(message); this.code = 'USAGE'; }
}
function usageError(message) { return new UsageError(message); }

/**
 * Parse --fx PAIR=RATE (e.g. USDJPY=150.5, USDIDR=16000).
 * RATE means: 1 BASE = RATE QUOTE (standard forex quote convention).
 * Returns the multiplier converting `quoteCcy` into `accountCcy`,
 * or throws a UsageError telling the user exactly which --fx to add.
 */
function fxMultiplier(quoteCcy, accountCcy, fxRaw) {
  const q = quoteCcy.toUpperCase();
  const a = accountCcy.toUpperCase();
  if (q === a) return 1;
  const m = /^([A-Za-z]{3})([A-Za-z]{3})=(\d+(?:\.\d+)?)$/.exec(String(fxRaw || '').trim());
  if (!m) {
    throw usageError(
      `cannot convert ${q} to ${a} without a rate. ` +
      `Add --fx ${q}${a}=<rate> or --fx ${a}${q}=<rate> ` +
      `(rate = how many QUOTE one BASE buys, e.g. --fx USDJPY=150.5).`);
  }
  const base = m[1].toUpperCase(), quote = m[2].toUpperCase(), rate = Number(m[3]);
  if (!(rate > 0)) throw usageError('--fx rate must be a positive number');
  if (base === a && quote === q) return 1 / rate; // value in QUOTE -> BASE
  if (base === q && quote === a) return rate;     // value in BASE -> QUOTE
  throw usageError(
    `--fx ${base}${quote}=${rate} does not connect ${q} to ${a}. ` +
    `Need --fx ${q}${a}=<rate> or --fx ${a}${q}=<rate>.`);
}

/** Account-currency value of one pip move on one standard lot. */
function pipValuePerLot(spec, quoteToAccount) {
  return spec.pip * spec.contractSize * quoteToAccount;
}

/** Account-currency value of one point move on one standard lot. */
function pointValuePerLot(spec, quoteToAccount) {
  return spec.point * spec.contractSize * quoteToAccount;
}

function roundDownToStep(value, step) {
  return Math.floor(value / step + 1e-9) * step;
}

/**
 * Core sizing math. slPrice = stop distance in price units (quote ccy).
 * Returns raw + broker-rounded lots, risk actually taken, and per-unit values.
 */
function sizePosition({ spec, balance, riskAmount, slPrice, quoteToAccount, lotStep = LOT_STEP, minLot = MIN_LOT }) {
  if (!(balance > 0)) throw usageError('--balance must be a positive number');
  if (!(riskAmount > 0)) throw usageError('risk amount must be positive (check --risk-pct / --risk-amount)');
  if (!(slPrice > 0)) throw usageError('stop-loss distance must be positive (check --sl-points / --sl-pips / --sl-price)');
  if (riskAmount > balance) {
    throw usageError(`risk ${fmtMoney(riskAmount)} exceeds balance ${fmtMoney(balance)} — refusing to size`);
  }
  const slPoints = slPrice / spec.point;
  const lossPerLot = slPrice * spec.contractSize * quoteToAccount;
  const lotsRaw = riskAmount / lossPerLot;
  let lots = roundDownToStep(lotsRaw, lotStep);
  const warnings = [];
  if (lots < minLot) {
    lots = 0;
    warnings.push(`even the minimum ${minLot} lot risks more than requested — position size 0 (widen the stop or raise risk)`);
  }
  const actualRisk = lots * lossPerLot;
  const pipValue = pipValuePerLot(spec, quoteToAccount);
  return {
    lotsRaw, lots, lotStep, minLot,
    riskRequested: riskAmount,
    riskActual: actualRisk,
    riskPctActual: (actualRisk / balance) * 100,
    slPoints, slPips: slPoints / 10,
    lossPerLot, pipValue,
    pointValue: pointValuePerLot(spec, quoteToAccount),
    notionalPerLot: spec.contractSize, // in base units (oz for XAUUSD)
    warnings,
  };
}

/** Reverse mode: user picked lots, how much is actually at risk? */
function verifyRisk({ spec, balance, lots, slPrice, quoteToAccount }) {
  if (!(balance > 0)) throw usageError('--balance must be a positive number');
  if (!(lots > 0)) throw usageError('--lots must be a positive number');
  if (!(slPrice > 0)) throw usageError('stop-loss distance must be positive (check --sl-points / --sl-pips / --sl-price)');
  const lossPerLot = slPrice * spec.contractSize * quoteToAccount;
  const riskAmount = lots * lossPerLot;
  return {
    lots, riskAmount,
    riskPct: (riskAmount / balance) * 100,
    slPoints: slPrice / spec.point,
    slPips: (slPrice / spec.point) / 10,
    lossPerLot,
    pipValue: pipValuePerLot(spec, quoteToAccount),
    balanceAfterLoss: balance - riskAmount,
  };
}

/** Margin in account currency for `lots` at `price` and `leverage`. */
function marginRequired({ spec, lots, price, leverage, quoteToAccount }) {
  if (!(lots > 0)) throw usageError('--lots must be a positive number');
  if (!(price > 0)) throw usageError('--price must be a positive number');
  if (!(leverage > 0)) throw usageError('--leverage must be a positive number');
  const marginQuote = (lots * spec.contractSize * price) / leverage;
  return marginQuote * quoteToAccount;
}

function fmtMoney(n, ccy) {
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy ? `${s} ${ccy}` : s;
}

function fmtLots(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

module.exports = {
  VERSION, SYMBOLS, LOT_STEP, MIN_LOT,
  UsageError, usageError,
  getSymbol, customSymbol, fxMultiplier,
  pipValuePerLot, pointValuePerLot,
  roundDownToStep, sizePosition, verifyRisk, marginRequired,
  fmtMoney, fmtLots,
};
