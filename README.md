# risk-sizer

> Offline lot-size and risk calculator for XAUUSD and forex, built for the terminal. Daily Tools #14.

## Why

Most lot-size calculators live on ad-covered websites: you need a browser, a connection, and you paste your balance into someone else's form. `risk-sizer` does the same arithmetic offline in one dependency-free Node file, with XAUUSD treated as a first-class symbol instead of an afterthought. Unlike the closest CLI alternative (`xauusdtools/xauusd-calculator`, a general-purpose math library), risk-sizer is a focused trading tool: it covers 10 forex symbols plus custom contracts, rounds down to the broker's 0.01 lot step so you never risk more than you asked, has a `verify` mode that audits a planned trade, prints an IDR-friendly report via `--fx`, and prompts you interactively when run bare on a phone (Termux).

## Install

```bash
git clone https://github.com/Kayzenn123/risk-sizer.git
cd risk-sizer
# no dependencies — Node >= 18 only
npm link   # optional: puts `risk-sizer` on your PATH
# or run directly:
node bin/risk-sizer.js --help
```

Requires: Node >= 18. Works fully offline; tested on Linux and Termux (Android).

## Usage

```bash
risk-sizer size   --symbol XAUUSD --balance 500 --risk-pct 1 --sl-points 300 [options]
risk-sizer verify --symbol XAUUSD --balance 500 --lots 0.05 --sl-points 300 [options]
risk-sizer specs [--json]
```

| Flag | Function | Default |
| --- | --- | --- |
| `--symbol NAME` | XAUUSD, EURUSD, GBPUSD, AUDUSD, NZDUSD, USDJPY, GBPJPY, EURJPY, USDCAD, USDCHF | (required) |
| `--balance N` | Account balance in account currency | (required) |
| `--risk-pct N` | Risk per trade, % of balance (0 < N ≤ 100) | (size: required unless `--risk-amount`) |
| `--risk-amount N` | Risk per trade as fixed money amount | — |
| `--sl-points N` | Stop distance in points | (one of the three required) |
| `--sl-pips N` | Stop distance in pips (10 pts = 1 pip) | — |
| `--sl-price N` | Stop distance in raw price units | — |
| `--lots N` | (verify) lots you plan to trade | — |
| `--price N` + `--leverage N` | Show margin required | — |
| `--account-ccy CODE` | Account currency | `USD` |
| `--fx PAIR=RATE` | e.g. `--fx USDJPY=150.5`, `--fx USDIDR=16000`; required when symbol quote ≠ account currency | — |
| `--contract-size/--digits/--pip/--quote` | Define a custom symbol | — |
| `--json` | Machine-readable output | human table |
| `-h/--help`, `-v/--version` | Help / version | — |

Run a subcommand without its required flags on a terminal and risk-sizer asks for them interactively. Exit codes: `0` ok, `1` runtime error, `2` usage error. Honors `NO_COLOR`; no colors when piped.

## Example output

Command:

```bash
risk-sizer size --symbol XAUUSD --balance 500 --risk-pct 1 --sl-points 300
```

Output (real, copied from an actual run):

```text
risk-sizer · XAUUSD — position size
  Balance                500.00 USD
  Risk allowed           5.00 USD
  Stop distance          300.00 pts (30.00 pips)
  Value per pip (1 lot)  10.00 USD
  Loss if stopped (1 lot) 300.00 USD
  Lots to trade          0.01
  Actual risk            3.00 USD (0.60%)
```

The raw 0.0167 lot is rounded **down** to the 0.01 broker step, so the actual risk ($3.00) stays under the requested $5.00.

Command:

```bash
risk-sizer verify --symbol EURUSD --balance 2000 --lots 0.5 --sl-pips 25
```

Output (real, copied from an actual run):

```text
risk-sizer · EURUSD — risk check
  Lots                   0.50
  Balance                2,000.00 USD
  Stop distance          250.00 pts (25.00 pips)
  Loss if stopped (1 lot) 250.00 USD
  Risk on this trade     125.00 USD (6.25%)  ← high risk
  Balance if stopped     1,875.00 USD
```

Command (IDR account, JSON output):

```bash
risk-sizer size --symbol XAUUSD --balance 8000000 --risk-pct 2 --sl-points 500 --account-ccy IDR --fx USDIDR=16000 --json
```

Output (real, copied from an actual run):

```text
{
  "command": "size",
  "symbol": "XAUUSD",
  "accountCcy": "IDR",
  "balance": 8000000,
  "lotsRaw": 0.02,
  "lots": 0.02,
  "lotStep": 0.01,
  "minLot": 0.01,
  "riskRequested": 160000,
  "riskActual": 160000,
  "riskPctActual": 2,
  "slPoints": 500,
  "slPips": 50,
  "lossPerLot": 8000000,
  "pipValue": 160000,
  "pointValue": 16000,
  "notionalPerLot": 100,
  "warnings": [],
  "margin": null
}
```

## How it works

1. The symbol table (`src/calc.js`) holds contract size, quoted digits, pip size, and quote currency per symbol.
2. Stop distance is normalized to price units, then loss-per-lot = distance × contract size × quote→account FX multiplier (`--fx`).
3. Lots = risk ÷ loss-per-lot, rounded **down** to the 0.01 lot step (never up — actual risk can only undershoot).
4. `verify` runs the math backwards: lots × loss-per-lot = money at risk, flagged when above 5%.
5. All math lives in pure functions in `src/calc.js`; `bin/risk-sizer.js` only parses args, prompts, and formats.

## Limitations

- No live prices or FX rates: every rate is typed in by you via `--fx` / `--price`, so double-check them before trading.
- Built-in symbols assume standard CFD specs (XAUUSD = 100 oz/lot, forex = 100,000/lot); if your broker differs, override with `--contract-size`.
- Lot step is fixed at 0.01 with a 0.01 minimum; brokers with different steps are not modeled.
- Margin needs both `--price` and `--leverage`; without them the margin row is omitted.
- This is arithmetic, not advice — see Disclaimer.

## Disclaimer

Not financial advice. risk-sizer only does arithmetic on numbers you provide; it does not predict markets, and correct math does not make a trade profitable. Verify every rate, spec, and stop distance with your broker before risking real money.

## Development

```bash
npm test   # node --test, 25 tests incl. CLI end-to-end; must pass twice in a row
```

## License

MIT

---
Ringkasan (Bahasa Indonesia): risk-sizer adalah kalkulator ukuran lot dan risiko untuk XAUUSD dan forex yang berjalan offline di terminal (Node, tanpa dependensi, ramah Termux). Beri saldo, persen risiko, dan jarak stop-loss — ia menghitung lot yang aman (dibulatkan ke bawah ke 0.01), nilai per pip, dan estimasi kerugian; mode `verify` mengaudit rencana trade yang sudah ada. Batasan utama: semua kurs diketik manual lewat `--fx`, bukan saran finansial.
