# Autonomous Greenhouse

An ESP32 greenhouse that restocks itself. An AI agent (Claude) watches fertilizer and water levels, predicts when they will run out, picks a supplier and pays with PayPal (Sandbox), always inside the budget the owner sets.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) 2026.

> Work in progress.

## How spending stays safe

The model proposes, the code decides. Every purchase the agent suggests goes through a plain, unit-tested rule check before any money moves:

- Suppliers the owner has not allowed are rejected.
- Orders that would go over the monthly budget are rejected, even with approval.
- Orders above the per-order maximum, or any order in "always ask" mode, wait for the owner's approval.
- Everything else is paid automatically.

## Status

- [x] Decision logic: consumption forecast, supplier choice, budget rules (`server/src/domain/`)
- [ ] Backend on Render, Claude agent, PayPal Sandbox, dashboard with simulation mode, ESP32 firmware

## Run the tests

Requires Node.js 22 or newer.

```bash
cd server
npm install
npm test
```

## Configuration

Copy `.env.example` to `.env` and fill in the values. Nothing reads them yet.

## License

[MIT](LICENSE)
