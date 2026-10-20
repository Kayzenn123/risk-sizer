#!/usr/bin/env node
'use strict';
/**
 * risk-sizer — offline lot-size and risk calculator for XAUUSD and forex.
 * Single file CLI, zero dependencies, Termux friendly.
 * Exit codes: 0 ok · 1 runtime error · 2 usage error.
 */
const readline = require('readline');
const calc = require('../src/calc.js');

const {
  VERSION, SYMBOLS, UsageError,
  getSymbol, customSymbol, fxMultiplier,
  sizePosition, verifyRisk, marginRequired,
  fmtMoney, fmtLots,
} = calc;

const useColor = !process.env.NO_COLOR && process.stderr.isTTY && process.stdout.isTTY;
const C = {
  red: s => useColor ? `\x1b[31m${s}\x1b[0m` : s,
  green: s => useColor ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: s => useColor ? `\x1b[33m${s}\x1b[0m` : s,
  bold: s => useColor ? `\x1b[1m${s}\x1b[0m` : s,
};

function num(v, flag) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`${flag} must be a number, got "${v}"`);
  return n;
}

function parseArgs(argv) {
  const out = { command: null, opts: {}, flags: new Set() };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (['help', 'version', 'json'].includes(key)) out.flags.add(key);
      else out.opts[key] = val;
    } else if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (ch === 'h') out.flags.add('help');
        else if (ch === 'v') out.flags.add('version');
        else throw new UsageError(`unknown short flag -${ch}`);
      }
    } else {
      rest.push(a);
    }
  }
  if (rest.length > 0) {
    if (!['size', 'verify', 'specs'].includes(rest[0])) throw new UsageError(`unknown command "${rest[0]}" (use: size, verify, specs)`);
    out.command = rest[0];
    if (rest.length > 1) throw new UsageError(`unexpected argument "${rest[1]}"`);
  }
  return out;
}

function resolveSpec(o) {
  if (o['contract-size'] || o['digits'] || o['pip'] || o['quote']) {
    return customSymbol({
      contractSize: num(o['contract-size'], '--contract-size'),
      digits: o['digits'] === undefined ? 5 : num(o['digits'], '--digits'),
      pip: num(o['pip'], '--pip'),
      quote: o['quote'] || 'USD',
    });
  }
  if (!o.symbol) throw new UsageError('missing --symbol (e.g. --symbol XAUUSD)');
  return getSymbol(o.symbol);
}

function resolveSl(o, spec) {
  if (o['sl-price'] !== undefined) return num(o['sl-price'], '--sl-price');
  if (o['sl-points'] !== undefined) return num(o['sl-points'], '--sl-points') * spec.point;
  if (o['sl-pips'] !== undefined) return num(o['sl-pips'], '--sl-pips') * spec.pip;
  throw new UsageError('missing stop distance: use --sl-points, --sl-pips, or --sl-price');
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

/** Interactive prompts for phone/Termux use; skipped when stdin is not a TTY. */
async function interactiveFill(command, o) {
  if (!process.stdin.isTTY) return o;
  const need = async (key, prompt, have) => {
    if (have !== undefined) return have;
    const a = await ask(prompt);
    if (!a) throw new UsageError('cancelled: required value missing');
    return a;
  };
  o = { ...o };
  o.symbol = await need('symbol', 'Symbol (e.g. XAUUSD): ', o.symbol);
  o.balance = await need('balance', 'Account balance: ', o.balance);
  if (command === 'size') {
    if (o['risk-pct'] === undefined && o['risk-amount'] === undefined) {
      o['risk-pct'] = await ask('Risk % per trade (e.g. 1): ');
    }
    if (o['sl-points'] === undefined && o['sl-pips'] === undefined && o['sl-price'] === undefined) {
      o['sl-points'] = await ask('Stop distance in points (e.g. 300): ');
    }
  } else if (command === 'verify') {
    o.lots = await need('lots', 'Lots: ', o.lots);
    if (o['sl-points'] === undefined && o['sl-pips'] === undefined && o['sl-price'] === undefined) {
      o['sl-points'] = await ask('Stop distance in points (e.g. 300): ');
    }
  }
  return o;
}

function riskAmountOf(o, balance) {
  if (o['risk-amount'] !== undefined) return num(o['risk-amount'], '--risk-amount');
  if (o['risk-pct'] !== undefined) {
    const pct = num(o['risk-pct'], '--risk-pct');
    if (!(pct > 0 && pct <= 100)) throw new UsageError('--risk-pct must be between 0 and 100');
    return (balance * pct) / 100;
  }
  throw new UsageError('missing risk: use --risk-pct (e.g. 1) or --risk-amount (e.g. 5)');
}

function tableRow(k, v) { return `  ${k.padEnd(22)} ${v}`; }

function renderSize(o, spec, r, accountCcy) {
  const L = [];
  L.push(C.bold(`risk-sizer · ${spec.name} — position size`));
  L.push(tableRow('Balance', fmtMoney(o.balance, accountCcy)));
  L.push(tableRow('Risk allowed', `${fmtMoney(r.riskRequested, accountCcy)}`));
  L.push(tableRow('Stop distance', `${fmtLots(r.slPoints)} pts (${fmtLots(r.slPips)} pips)`));
  L.push(tableRow('Value per pip (1 lot)', fmtMoney(r.pipValue, accountCcy)));
  L.push(tableRow('Loss if stopped (1 lot)', fmtMoney(r.lossPerLot, accountCcy)));
  L.push(C.green(tableRow('Lots to trade', fmtLots(r.lots))) + (r.lots === 0 ? '  ← too small, see warning' : ''));
  L.push(tableRow('Actual risk', `${fmtMoney(r.riskActual, accountCcy)} (${r.riskPctActual.toFixed(2)}%)`));
  if (o.margin !== undefined) L.push(tableRow('Margin required', fmtMoney(o.margin, accountCcy)));
  for (const w of r.warnings) L.push(C.yellow('warning: ' + w));
  return L.join('\n');
}

function renderVerify(o, spec, r, accountCcy) {
  const L = [];
  L.push(C.bold(`risk-sizer · ${spec.name} — risk check`));
  L.push(tableRow('Lots', fmtLots(r.lots)));
  L.push(tableRow('Balance', fmtMoney(o.balance, accountCcy)));
  L.push(tableRow('Stop distance', `${fmtLots(r.slPoints)} pts (${fmtLots(r.slPips)} pips)`));
  L.push(tableRow('Loss if stopped (1 lot)', fmtMoney(r.lossPerLot, accountCcy)));
  const riskLine = tableRow('Risk on this trade', `${fmtMoney(r.riskAmount, accountCcy)} (${r.riskPct.toFixed(2)}%)`);
  L.push(r.riskPct > 5 ? C.red(riskLine + '  ← high risk') : C.green(riskLine));
  L.push(tableRow('Balance if stopped', fmtMoney(r.balanceAfterLoss, accountCcy)));
  if (o.margin !== undefined) L.push(tableRow('Margin required', fmtMoney(o.margin, accountCcy)));
  return L.join('\n');
}

function renderSpecs(json) {
  const rows = Object.entries(SYMBOLS).map(([name, s]) => ({
    symbol: name, contract: s.contractSize, digits: s.digits,
    pip: s.pip, quote: s.quote, label: s.label,
  }));
  if (json) return JSON.stringify(rows, null, 2);
  const L = [C.bold('risk-sizer · built-in symbols'), ''];
  L.push('  ' + 'SYMBOL'.padEnd(8) + 'CONTRACT'.padEnd(10) + 'DIGITS  PIP'.padEnd(14) + 'QUOTE  DESCRIPTION');
  for (const r of rows) {
    L.push('  ' + r.symbol.padEnd(8) + String(r.contract).padEnd(10) +
      String(r.digits).padEnd(7) + String(r.pip).padEnd(7) + r.quote.padEnd(7) + r.label);
  }
  return L.join('\n');
}

const HELP = `risk-sizer — offline lot-size and risk calculator for XAUUSD and forex.

Usage:
  risk-sizer size   --symbol XAUUSD --balance 500 --risk-pct 1 --sl-points 300 [options]
  risk-sizer verify --symbol XAUUSD --balance 500 --lots 0.05 --sl-points 300 [options]
  risk-sizer specs [--json]

Options:
  --symbol NAME        XAUUSD, EURUSD, GBPUSD, AUDUSD, NZDUSD, USDJPY, GBPJPY,
                       EURJPY, USDCAD, USDCHF (or use --contract-size for custom)
  --balance N          account balance in account currency
  --risk-pct N         risk per trade in percent of balance (0 < N <= 100)
  --risk-amount N      risk per trade as fixed money amount (alternative)
  --sl-points N        stop distance in points (smallest quoted digit)
  --sl-pips N          stop distance in pips (10 points = 1 pip)
  --sl-price N         stop distance in raw price units
  --lots N             (verify) lots you plan to trade
  --leverage N         (with --price) show margin required
  --price N            current price, needed for margin calculation
  --account-ccy CODE   account currency, default USD
  --fx PAIR=RATE       conversion rate, e.g. --fx USDJPY=150.5 or --fx USDIDR=16000.
                       Required when symbol quote differs from account currency.
  --contract-size N    custom symbol: units per 1 lot (XAUUSD default 100 oz)
  --digits N           custom symbol: quoted decimals (default 5)
  --pip N              custom symbol: price distance of one pip (default 10 points)
  --quote CODE         custom symbol: quote currency (default USD)
  --json               machine-readable output
  -h, --help           this help
  -v, --version        version

Run a subcommand without required flags on a terminal and risk-sizer
asks for them interactively (handy on Termux).

Examples:
  risk-sizer size --symbol XAUUSD --balance 500 --risk-pct 1 --sl-points 300
  risk-sizer verify --symbol EURUSD --balance 2000 --lots 0.5 --sl-pips 25
  risk-sizer size --symbol XAUUSD --balance 8000000 --risk-pct 2 --sl-points 500 \\
      --account-ccy IDR --fx USDIDR=16000 --json

Exit codes: 0 ok, 1 runtime error, 2 usage error. Not financial advice.`;

async function main() {
  const { command, opts, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('version')) { console.log(VERSION); return; }
  if (flags.has('help') || !command) { console.log(HELP); return; }
  const asJson = flags.has('json');

  if (command === 'specs') { console.log(renderSpecs(asJson)); return; }

  let o = await interactiveFill(command, opts);
  const accountCcy = (o['account-ccy'] || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(accountCcy)) throw new UsageError('--account-ccy must be a 3-letter code');
  const spec = resolveSpec(o);
  const quoteToAccount = fxMultiplier(spec.quote, accountCcy, o['fx']);
  const balance = num(o.balance, '--balance');
  const slPrice = resolveSl(o, spec);

  let margin;
  if (o['price'] !== undefined || o['leverage'] !== undefined) {
    if (o['price'] === undefined || o['leverage'] === undefined) {
      throw new UsageError('margin needs both --price and --leverage');
    }
  }

  if (command === 'size') {
    const risk = riskAmountOf(o, balance);
    const r = sizePosition({ spec, balance, riskAmount: risk, slPrice, quoteToAccount });
    if (o['price'] !== undefined) {
      margin = marginRequired({ spec, lots: r.lots, price: num(o['price'], '--price'), leverage: num(o['leverage'], '--leverage'), quoteToAccount });
    }
    if (asJson) {
      console.log(JSON.stringify({ command, symbol: spec.name, accountCcy, balance, ...r, margin: margin ?? null, warnings: r.warnings }, null, 2));
    } else {
      console.log(renderSize({ balance, margin }, spec, r, accountCcy));
    }
  } else { // verify
    const lots = num(o.lots, '--lots');
    const r = verifyRisk({ spec, balance, lots, slPrice, quoteToAccount });
    if (o['price'] !== undefined) {
      margin = marginRequired({ spec, lots, price: num(o['price'], '--price'), leverage: num(o['leverage'], '--leverage'), quoteToAccount });
    }
    if (asJson) {
      console.log(JSON.stringify({ command, symbol: spec.name, accountCcy, balance, ...r, margin: margin ?? null }, null, 2));
    } else {
      console.log(renderVerify({ balance, margin }, spec, r, accountCcy));
    }
  }
}

main().catch(err => {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}`);
    console.error('run "risk-sizer --help" for usage.');
    process.exit(2);
  }
  console.error(`error: ${err.message || err}`);
  process.exit(1);
});
