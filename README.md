# Autonomous Greenhouse

An ESP32 greenhouse that restocks itself. An AI agent (Claude) watches fertilizer and water levels, predicts when they will run out, picks a supplier and pays with PayPal (Sandbox), always inside the budget the owner sets.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) 2026.

## Try it

The demo runs at **https://invernadero-api-jn3j.onrender.com** on PayPal Sandbox, so no real money moves. All four users share the password **`greenhouse-demo-yfny9v86`**.

| Log in as | Role | What they can do |
| --- | --- | --- |
| `gerente@agroandes.test` | Manager | Everything: budgets, approvals, PayPal, the agent and the simulation |
| `encargado@agroandes.test` | Greenhouse manager of Invernadero 1 | Approve its orders up to $500 and confirm its deliveries |
| `operador@agroandes.test` | Operator of Invernadero 1 | See its tanks and confirm its deliveries |
| `compras@agroandes.test` | Purchasing | See every greenhouse and order, never approve or receive |

You do not need a PayPal account: the demo company's PayPal Sandbox account is already connected, so approved orders are paid without anyone signing in to PayPal. To try connecting one yourself, press **Use another PayPal account** as the manager and sign in with a Sandbox personal account from your own [PayPal Developer dashboard](https://developer.paypal.com/dashboard/accounts). That account then pays the next orders.

### A five-minute tour

Log in as the manager.

1. **Make a supply run low.** Invernadero 2 runs on simulated sensors. Drag the slider under its *Fertilizante NPK* tank down to about 10%. The tank turns yellow: it is below its dashed line, where the code asks Claude to restock.
2. **Run the agent.** Press **Run the agent now** and wait about 15 seconds. Claude gets the forecast and the suppliers' offers and places an order; the code prices it from the catalog and runs it through the approval rules. Under $100 it is paid at once with PayPal: the order shows its purchase order number and PayPal's order id, and **What the agent decided** shows Claude's reasoning. A bigger order waits in **Waiting for you** for your approval instead.
3. **Receive it.** In **Waiting for you**, press **Confirm delivery**. Lower a number if something did not arrive, and the order is marked as a short delivery. The tank refills with what arrived.
4. **Hit the budget.** Under Invernadero 3, press **Change budget** and set it to 10. Drag its NPK tank down and run the agent again: nothing is bought, because even the cheapest order would go over the budget.
5. **Get the month for the accountant.** Under **Order history**, download the CSV: purchase order, PayPal payment and delivery on one row.
6. **Let time pass.** **Skip 3 days** makes the simulated greenhouses use three days of stock. The agent also runs on its own every 15 minutes.
7. **Start over.** **Restart demo** deletes orders, payments and the audit log, and puts budgets, rules and stock back as they started.

Then log in as `operador@agroandes.test` to see the dashboard of someone who works in one greenhouse: only Invernadero 1, its deliveries, and no money controls. Invernadero 1 reads the real ESP32. When the device is offline, its tanks say when they last heard from it.

The demo is open to everyone, so it has limits nobody can get around: Claude is asked at most 40 times a day, and by hand at most 3 times a minute; logins and the API are rate limited. **Restart demo** puts everything back.

## How the agent works

Every 15 minutes (or when the manager presses run), the server checks each greenhouse:

1. **The code forecasts.** From the sensor readings it works out each supply's level, daily use and days left.
2. **The code decides whether to ask.** Claude is only called when a supply is below 15% or will run out before the fastest delivery plus a 3-day margin, and no order for it is already on its way.
3. **Claude chooses.** It gets the supplies that need restocking and the catalog offers that can restock them, and calls a `place_order` tool: which supplier, which offers, how many packs, and one or two sentences of reasoning.
4. **The code checks every order.** Only supplies that need it, never more than fits in the container, one order per supplier; the order is priced from the catalog and goes through the approval matrix below. Claude sees the verdict (paid on its own, waiting for approval, or rejected) and can adjust.
5. **Everything is kept.** Each run is stored with Claude's summary (`GET /api/agent/runs`), each order with its reasoning.

It uses `claude-opus-5-5` by default (`AGENT_MODEL` to change it), with Anthropic's server-side fallback in case a request is declined. Without `ANTHROPIC_API_KEY` the agent stays off and everything else works.

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
- **Prices come from the catalog, never from the model:** an order only names offers and packs; the server prices it from purchasing's catalog and keeps that price, even if the catalog changes later. Purchasing sets prices but cannot approve payments; the manager approves payments but cannot set prices.
- **New suppliers need the manager:** purchasing can add a supplier, but the agent cannot buy from it until a manager approves it, so nobody can create a supplier and send it orders on their own.
- **Everything is on record:** every order, approval, budget, rule, supplier and price change goes into an audit log (`GET /api/audit`, manager only) in the same transaction as the change, with who, when, and the before and after.

## How orders are paid

The manager connects the company's PayPal account once from the dashboard ([PayPal Vault](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal), without a purchase). After that, every approved order is paid from it with nobody present: an order the rules paid on their own right away, an order a person approved the moment they approve it. Each payment keeps PayPal's order and capture ids as proof.

- **Never charged twice:** each payment has its own `PayPal-Request-Id`. If PayPal does not answer, it is asked again with the same id, so PayPal returns the first result instead of charging again; once PayPal has an order for a payment, it is only looked up, never charged again. Two servers or two clicks cannot pay the same order at once.
- **Nothing is lost:** approving and queueing the payment happen in one transaction, and a background round every 30 seconds pays whatever is still waiting (PayPal not connected yet, a restart, PayPal down).
- **Only this company's account:** connecting finishes with the setup this company started, never an id sent by the browser, and only the manager can connect PayPal or retry a failed payment.
- **When nobody knows, nobody resends:** if PayPal never confirmed an attempt, the same request is only sent again within an hour (PayPal does not say how long it remembers one); after that the payment waits for the manager to check PayPal. A request that never reached PayPal (PayPal down, or refusing the app's credentials) just waits in the queue.
- **The code moves the money, not the model:** Claude never sees PayPal; it only proposes orders.

The money goes to the PayPal business account of this app's credentials, which stands in for the suppliers in the demo; paying each supplier's own PayPal account would need PayPal's platform (partner) onboarding.

Without `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` everything else works and approved orders wait unpaid.

## Purchase orders and deliveries

An order becomes a purchase order when it is approved, by the rules or by a person, and gets a number: `PO-2026-0001`, `PO-2026-0002`… counted per company and year, with no gaps. Orders waiting for approval or rejected are only requests and get no number. Each purchase order can be matched against two other records, a simple version of the three-way match companies use:

1. **Purchase order:** greenhouse, supplier, items, prices and total, and who approved it.
2. **Payment:** PayPal's order and capture ids. The purchase order number is sent to PayPal as the payment's reference (`custom_id`), so it shows up in PayPal's reports.
3. **Delivery:** the greenhouse's operator, its greenhouse manager or the manager confirms how many packs of each item arrived. If anything is missing, the order is marked as a short delivery so the manager can take it up with the supplier. Purchasing chooses the suppliers, so it cannot confirm deliveries.

Each delivery is confirmed once and recorded in the audit log, with what was ordered and what arrived.

Everyone sees a **Waiting for you** inbox with only what they can act on now: approvals within their reach for the greenhouse manager and the manager, deliveries to confirm for the greenhouse staff. Purchasing never gets approvals. The **order history** filters by month, greenhouse and status, and every order keeps the agent's reasoning.

For the accountant, **Download purchase orders (CSV)** exports the month's purchase orders, one row each with its PayPal payment and its delivery. The file opens in Excel or Google Sheets with accents intact, and no cell can run as a spreadsheet formula, even text written by the model or by purchasing. Months follow the company's calendar, the same month the budget counts the order in.

## Simulated sensors

Greenhouse 1 gets its levels from the real ESP32. Greenhouses 2 and 3 have no hardware, so the server simulates their sensors: each supply uses stock at its own daily rate, with a reading every 5 minutes, and the agent treats them exactly like real ones. The dashboard draws every supply as a tank with a dashed line where the code asks Claude to restock.

Logged in as the manager you can:

- drag a tank's slider to set its level,
- skip 1 or 3 days ahead to let days of use pass,
- run the agent now and see what it ordered and why,
- restart the demo: orders, payments, agent runs and the audit log are deleted, and budgets, rules and stock go back to how they started. Only the demo company can be restarted, and the PayPal connection stays.

Confirming a delivery to a simulated greenhouse refills its tank. The server never writes readings for the real ESP32.

## Status

- [x] Decision logic: consumption forecast, supplier choice, budget rules (`server/src/domain/`)
- [x] PayPal Sandbox vaulting checked: a saved PayPal account is charged without the owner present
- [ ] ESP32 firmware for fertilizer and water levels (`firmware/Invernadero`): written, not yet tested on hardware
- [x] Backend base: data model (company, greenhouses, devices, supplies, readings) and `POST /api/readings` with per-device keys
- [x] Login with four roles; permissions checked on the server, every route requires a session unless marked public
- [x] Deployed on Render at https://invernadero-api-jn3j.onrender.com (server and Postgres from `render.yaml`)
- [x] Approval matrix with a budget per greenhouse: approval inbox, approve and reject, budgets and auto-pay limit set by the manager
- [x] Supplier catalog managed by purchasing, new suppliers approved by the manager; every order is priced from it and keeps the price of the moment
- [x] Audit log of orders, approvals, budgets, rules and catalog changes
- [x] Claude purchasing agent: forecasts each supply, picks offers and places orders through the matrix (`server/src/agent/`)
- [x] PayPal payments: the manager connects PayPal once, approved orders are paid with the saved account (`server/src/payments/`)
- [x] Purchase orders numbered on approval, and deliveries confirmed by the greenhouse (`server/src/orders/`)
- [x] Inbox per role, order history with filters, and a monthly CSV of purchase orders for the accountant
- [x] Dashboard, first part: login, PayPal connection, orders with their payment and delivery, approve, reject and confirm deliveries (`server/public/`)
- [x] Dashboard: levels, days left and budget per greenhouse, what the agent decided, and simulated sensors for greenhouses without hardware (`server/src/simulation/`)

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

### End-to-end tests

A real browser drives the dashboard through the main flows:

- logging in for each role;
- lowering a tank until the agent orders it, with PayPal paying right away;
- confirming the delivery, which refills the tank;
- a budget too small for any order stopping the agent;
- a greenhouse manager approving an order;
- an operator reporting a short delivery;
- downloading the month's CSV.

They run against `server/e2e/server.ts`: the real app on a fresh in-memory database, with a scripted stand-in for Claude and a fake PayPal, so they spend nothing and need no keys.

```bash
cd server
npm run e2e
```

They use the installed Microsoft Edge. Set `PLAYWRIGHT_CHANNEL=chrome` for Chrome, or run `npx playwright install chromium` and set `PLAYWRIGHT_CHANNEL=chromium`.

## Run the backend

Requires Node.js 24 or newer. Copy `.env.example` to `.env` and set at least `DEVICE_API_KEY`.

```bash
cd server
npm install
npm run dev
```

Open http://localhost:3000 for the dashboard. Without `DATABASE_URL` the server uses a local PGlite database in `server/.data` and creates a demo company with three greenhouses on first start. The four demo users from [Try it](#try-it) log in with the `DEMO_PASSWORD` of your `.env`. The ESP32 posts to `POST /api/readings` with its key in the `X-Device-Key` header.

## Deploy on Render

`render.yaml` describes the server and a private Postgres database.

1. In the Render Dashboard choose **New > Blueprint** and pick this repository.
2. When asked, enter `DEVICE_API_KEY` (the same value as the ESP32's `secrets.h`), `DEMO_PASSWORD`, and optionally `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. Apply. Every push to `main` redeploys the server.

Then point the ESP32 at it: set `SERVER_URL` in `secrets.h` to the service's `https://….onrender.com` address and upload the sketch again.

## License

[MIT](LICENSE)
