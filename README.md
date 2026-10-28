# Autonomous Greenhouse

An ESP32 greenhouse that restocks itself. An AI agent (Claude) watches fertilizer and water levels, predicts when they will run out, picks a supplier and pays with PayPal (Sandbox), always inside the budget the owner sets.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) 2026.

> Work in progress.

## How spending stays safe

The model proposes, the code decides. Every order goes through a plain, unit-tested approval matrix (`server/src/domain/approval.ts`) before any money moves:

| Order | Who decides |
| --- | --- |
| Would go over the greenhouse's monthly budget | Nobody: rejected. Only the manager can raise the budget |
| Up to $100 | The agent pays on its own |
| Up to the greenhouse manager's limit ($500) | That greenhouse's manager, or the manager |
| Above that | The manager |

The amounts are examples the manager can change. On top of the matrix:

- **No order splitting:** who must approve depends on the order plus everything bought from the same supplier for that greenhouse in the last 7 days, so a big order cut into small ones still needs approval.
- **Pending orders hold budget:** an order waiting for approval already counts against the month, and the budget is checked again when someone approves it.
- **One at a time per greenhouse:** orders and approvals lock the greenhouse while they check the budget, so two of them can never spend the same money.
- **Nobody approves outside their reach:** not their own request, not another greenhouse, and never purchasing, who manages the suppliers.

## Status

- [x] Decision logic: consumption forecast, supplier choice, budget rules (`server/src/domain/`)
- [x] PayPal Sandbox vaulting checked: a saved PayPal account is charged without the owner present
- [ ] ESP32 firmware for fertilizer and water levels (`firmware/Invernadero`): written, not yet tested on hardware
- [x] Backend base: data model (company, greenhouses, devices, supplies, readings) and `POST /api/readings` with per-device keys
- [x] Login with four roles; permissions checked on the server, every route requires a session unless marked public
- [x] Deployed on Render at https://invernadero-api-jn3j.onrender.com (server and Postgres from `render.yaml`)
- [x] Approval matrix with a budget per greenhouse: approval inbox, approve and reject, budgets and auto-pay limit set by the manager
- [ ] Supplier catalog, Claude agent, PayPal integration, dashboard with simulation mode

## Firmware

`firmware/Invernadero` is an Arduino sketch for ESP32, ESP32-S3 or ESP32-C6. It weighs the fertilizer with an HX711 load cell, measures the water tank with an ultrasonic sensor, and posts both levels to `POST /api/readings` every minute. Wiring, calibration commands and the payload format are in the header of `Invernadero.ino`.

1. Install the `esp32` boards and the `HX711` (Rob Tillaart) and `ArduinoJson` libraries.
2. Copy `secrets.example.h` to `secrets.h` and fill in WiFi, server URL and device key.
3. Upload, open the Serial Monitor at 115200 and calibrate.

## Run the tests

Requires Node.js 22 or newer.

```bash
cd server
npm install
npm test
```

## Run the backend

Requires Node.js 24 or newer. Copy `.env.example` to `.env` and set at least `DEVICE_API_KEY`.

```bash
cd server
npm install
npm run dev
```

Without `DATABASE_URL` the server uses a local PGlite database in `server/.data` and creates a demo company with three greenhouses on first start. The ESP32 posts to `POST /api/readings` with its key in the `X-Device-Key` header.

### Demo users

All four use the password set in `DEMO_PASSWORD`.

| Email | Role | Can do |
| --- | --- | --- |
| `operador@agroandes.test` | Operator | See greenhouse 1, confirm deliveries |
| `encargado@agroandes.test` | Greenhouse manager | Approve greenhouse 1 orders up to $500 |
| `compras@agroandes.test` | Purchasing | Manage suppliers and prices, never approve |
| `gerente@agroandes.test` | Manager | Set budgets and limits, approve any order |

## Deploy on Render

`render.yaml` describes the server and a private Postgres database.

1. In the Render Dashboard choose **New > Blueprint** and pick this repository.
2. When asked, enter `DEVICE_API_KEY` (the same value as the ESP32's `secrets.h`) and `DEMO_PASSWORD`.
3. Apply. Every push to `main` redeploys the server.

Then point the ESP32 at it: set `SERVER_URL` in `secrets.h` to the service's `https://….onrender.com` address and upload the sketch again.

## License

[MIT](LICENSE)
