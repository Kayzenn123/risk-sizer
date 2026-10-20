'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const calc = require('../src/calc.js');
const BIN = path.join(__dirname, '..', 'bin', 'risk-sizer.js');

const run = (args, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
};

// --- pure math ---

test('pip value: 1 lot XAUUSD = $10 per pip', () => {
  const s = calc.getSymbol('XAUUSD');
  assert.equal(calc.pipValuePerLot(s, 1), 10);
});

test('pip value: 1 lot EURUSD = $10 per pip', () => {
  const s = calc.getSymbol('EURUSD');
  assert.equal(calc.pipValuePerLot(s, 1), 10);
});

test('pip value: 1 lot USDJPY = 1000 JPY per pip', () => {
  const s = calc.getSymbol('USDJPY');
  assert.equal(calc.pipValuePerLot(s, 1), 1000);
});

test('fx: same currency needs no rate', () => {
  assert.equal(calc.fxMultiplier('USD', 'USD'), 1);
});

test('fx: USDJPY=150.5 converts JPY to USD by division', () => {
  const m = calc.fxMultiplier('JPY', 'USD', 'USDJPY=150.5');
  assert.ok(Math.abs(m - 1 / 150.5) < 1e-12);
});

test('fx: USDIDR=16000 converts USD to IDR by multiplication', () => {
  assert.equal(calc.fxMultiplier('USD', 'IDR', 'USDIDR=16000'), 16000);
});

test('fx: missing rate throws actionable UsageError', () => {
  assert.throws(() => calc.fxMultiplier('JPY', 'USD', undefined), /--fx USDJPY=<rate>/);
});

test('fx: unrelated pair throws UsageError', () => {
  assert.throws(() => calc.fxMultiplier('JPY', 'USD', 'EURUSD=1.08'), /does not connect/);
});

test('size: $500 balance, 1% risk, 300pt XAUUSD stop -> 0.01 lot', () => {
  const s = calc.getSymbol('XAUUSD');
  const r = calc.sizePosition({ spec: s, balance: 500, riskAmount: 5, slPrice: 300 * s.point, quoteToAccount: 1 });
  assert.equal(r.lotsRaw.toFixed(4), '0.0167');
  assert.equal(r.lots, 0.01);
  assert.equal(r.riskActual, 3);
  assert.ok(r.riskActual <= r.riskRequested, 'rounded lots must never exceed requested risk');
});

test('size: rounding down never exceeds requested risk (sweep)', () => {
  const s = calc.getSymbol('EURUSD');
  for (const risk of [1, 7.5, 23, 100]) {
    for (const slPips of [5, 25, 137]) {
      const r = calc.sizePosition({
        spec: s, balance: 10000, riskAmount: risk,
        slPrice: slPips * s.pip, quoteToAccount: 1,
      });
      assert.ok(r.riskActual <= risk + 1e-9, `risk ${risk} sl ${slPips}: actual ${r.riskActual}`);
    }
  }
});

test('size: risk above balance is refused', () => {
  const s = calc.getSymbol('XAUUSD');
  assert.throws(
    () => calc.sizePosition({ spec: s, balance: 100, riskAmount: 101, slPrice: 1, quoteToAccount: 1 }),
    /exceeds balance/);
});

test('size: dust risk yields 0 lots with warning', () => {
  const s = calc.getSymbol('XAUUSD');
  const r = calc.sizePosition({ spec: s, balance: 10000, riskAmount: 0.5, slPrice: 300 * s.point, quoteToAccount: 1 });
  assert.equal(r.lots, 0);
  assert.equal(r.warnings.length, 1);
});

test('verify: 0.5 lots EURUSD, 25 pip stop, $2000 balance', () => {
  const s = calc.getSymbol('EURUSD');
  const r = calc.verifyRisk({ spec: s, balance: 2000, lots: 0.5, slPrice: 25 * s.pip, quoteToAccount: 1 });
  assert.equal(r.riskAmount, 125);
  assert.equal(r.riskPct, 6.25);
  assert.equal(r.balanceAfterLoss, 1875);
});

test('margin: 0.01 XAUUSD at $2650, 1:100 -> $26.50', () => {
  const s = calc.getSymbol('XAUUSD');
  const m = calc.marginRequired({ spec: s, lots: 0.01, price: 2650, leverage: 100, quoteToAccount: 1 });
  assert.ok(Math.abs(m - 26.5) < 1e-9);
});

test('getSymbol: unknown symbol lists known ones', () => {
  assert.throws(() => calc.getSymbol('BTCUSD'), /Known symbols/);
});

test('customSymbol: rejects bad contract size', () => {
  assert.throws(() => calc.customSymbol({ contractSize: -5, digits: 5, quote: 'USD' }), /--contract-size/);
});

// --- CLI end to end ---

test('e2e: --help exits 0 and documents subcommands', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /risk-sizer size/);
  assert.match(r.stdout, /risk-sizer verify/);
  assert.match(r.stdout, /--sl-points/);
});

test('e2e: --version prints semver', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('e2e: size XAUUSD prints 0.01 lots table', () => {
  const r = run(['size', '--symbol', 'XAUUSD', '--balance', '500', '--risk-pct', '1', '--sl-points', '300']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Lots to trade/);
  assert.match(r.stdout, /0\.01/);
  assert.match(r.stdout, /3\.00 USD/); // actual risk after rounding down
});

test('e2e: --json is valid JSON with expected fields', () => {
  const r = run(['size', '--symbol', 'XAUUSD', '--balance', '500', '--risk-pct', '1',
    '--sl-points', '300', '--json']);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.symbol, 'XAUUSD');
  assert.equal(j.lots, 0.01);
  assert.equal(j.accountCcy, 'USD');
});

test('e2e: verify flags high risk in output', () => {
  const r = run(['verify', '--symbol', 'EURUSD', '--balance', '2000', '--lots', '0.5', '--sl-pips', '25']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /6\.25%/);
});

test('e2e: bad args exit 2 without stack trace', () => {
  const r = run(['size', '--symbol', 'XAUUSD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^error: /m);
  assert.doesNotMatch(r.stderr + r.stdout, /at .*\(.*:\d+:\d+\)/);
});

test('e2e: missing --fx for USDJPY exits 2 with actionable hint', () => {
  const r = run(['size', '--symbol', 'USDJPY', '--balance', '1000', '--risk-pct', '1', '--sl-pips', '20']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--fx USDJPY=<rate>/);
});

test('e2e: NO_COLOR strips ANSI codes', () => {
  const r = run(['specs'], { NO_COLOR: '1' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /\x1b\[/);
});

test('e2e: specs lists built-in symbols', () => {
  const r = run(['specs']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /XAUUSD/);
  assert.match(r.stdout, /USDJPY/);
});
