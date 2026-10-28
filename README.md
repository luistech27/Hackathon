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
- [x] PayPal Sandbox vaulting checked: a saved PayPal account is charged without the owner present
- [ ] ESP32 firmware for fertilizer and water levels (`firmware/Invernadero`): written, not yet tested on hardware
- [ ] Backend on Render, Claude agent, PayPal integration, dashboard with simulation mode

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

## Configuration

Copy `.env.example` to `.env` and fill in the values. Nothing reads them yet.

## License

[MIT](LICENSE)
