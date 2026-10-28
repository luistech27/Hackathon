/*
  ============================================================
   INVERNADERO AUTÓNOMO - Niveles de insumos con ESP32
  ============================================================
   Mide cuánto fertilizante queda (balanza) y cuánta agua hay en el tanque
   (sensor ultrasónico) y lo envía al backend cada minuto. El agente del
   backend decide si hay que comprar; el ESP32 solo mide.

   Conexiones (los pines se eligen solos según la placa con la que compilas):
                        ESP32 DevKit   ESP32-S3   ESP32-C6
     HX711 DT                25            4          18
     HX711 SCK               26            5          19
     Ultrasónico TRIG        27            6          20
     Ultrasónico ECHO        32            7          21   <- por un divisor 1kΩ / 2kΩ
     Balanza HX711: VCC -> 3.3V, GND -> GND. La celda va debajo del envase de fertilizante.
     Ultrasónico HC-SR04 o JSN-SR04T (impermeable): VCC -> 5V, GND -> GND.
       El ECHO sale a 5V: sin el divisor dañas el ESP32.
       El sensor va en la tapa del tanque, mirando hacia el agua.

   Antes de compilar: copia secrets.example.h como secrets.h y llena tus datos.
   Librerías: HX711 (Rob Tillaart) y ArduinoJson.
   S3 y C6 conectados por su USB nativo: en Herramientas activa "USB CDC On Boot"
   para ver el Monitor Serie.

   Calibración (Monitor Serie a 115200; se guarda en la flash):
     T      -> tara: con el envase VACÍO sobre la balanza, la deja en 0 g
     C500   -> después de T, pon un peso conocido (500 g) y calibra
     V      -> con el tanque VACÍO, guarda la distancia al fondo (borra la calibración de litros)
     L20    -> después de V, con 20 litros en el tanque, calcula litros por cm
     E      -> muestra las lecturas actuales
     S      -> envía las lecturas ahora
     P      -> repite la autoprueba (por si no alcanzaste a verla al encender)
   Calibra el tanque a la temperatura normal del invernadero: el sonido cambia con el calor.

   Ante la duda no se envía nada: sin calibrar, sin sensor, lectura rara o autoprueba
   fallida. Así el agente nunca compra por un número inventado.

   Envía:  POST {SERVER_URL}/api/readings   con la cabecera X-Device-Key
     {"readings":[{"supplyId":"fertilizer","level":812.4},{"supplyId":"water","level":37.2}]}
     level = gramos de fertilizante o litros de agua
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <HX711.h>
#include "levels.h"
#include "selftest.h"
#include "secrets.h"

// ===================== CONFIGURACIÓN =====================
#if defined(CONFIG_IDF_TARGET_ESP32S3)
const uint8_t PIN_HX711_DT = 4, PIN_HX711_SCK = 5, PIN_TRIG = 6, PIN_ECHO = 7;
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
const uint8_t PIN_HX711_DT = 18, PIN_HX711_SCK = 19, PIN_TRIG = 20, PIN_ECHO = 21;
#elif defined(CONFIG_IDF_TARGET_ESP32)
const uint8_t PIN_HX711_DT = 25, PIN_HX711_SCK = 26, PIN_TRIG = 27, PIN_ECHO = 32;
#else
#error "Placa no soportada: agrega sus pines en CONFIGURACIÓN"
#endif

const unsigned long SEND_INTERVAL_MS   = 60000;  // cada cuánto se envían lecturas
const unsigned long WIFI_TIMEOUT_MS    = 15000;  // sin WiFi sigue igual: la calibración no lo necesita
const unsigned long ECHO_TIMEOUT_US    = 30000;  // ~5 m de alcance; sin eco = sin lectura
const unsigned long SCALE_TIMEOUT_MS   = 1000;   // HX711 que no responde = desconectado
const uint8_t       ULTRASONIC_SAMPLES = 7;
const uint8_t       SCALE_SAMPLES      = 10;
const float         MIN_CALIBRATION_COUNTS = 1000;  // menos que esto es ruido: no hay peso encima

HX711 scale;
Preferences memoria;           // calibración en la flash
bool selfTestOk = false;
bool scaleCalibrated = false;
float emptyDistanceCm = 0;     // del sensor al fondo con el tanque vacío
float litersPerCm = 0;         // 0 = tanque sin calibrar
unsigned long lastSendMs = 0;

// ===================== SENSORES =====================
float readDistanceCm() {
  float samples[ULTRASONIC_SAMPLES];
  for (uint8_t i = 0; i < ULTRASONIC_SAMPLES; i++) {
    digitalWrite(PIN_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_TRIG, LOW);
    samples[i] = echoToCm(pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US));
    delay(60);  // deja que se apague el eco anterior
  }
  return medianOfValid(samples, ULTRASONIC_SAMPLES);
}

bool scaleReady() {
  return scale.wait_ready_timeout(SCALE_TIMEOUT_MS);
}

float readFertilizerGrams() {
  if (!scaleCalibrated || !scaleReady()) return NAN;
  return gramsOrNan(scale.get_units(SCALE_SAMPLES));
}

float readWaterLiters() {
  return litersFromDistance(readDistanceCm(), emptyDistanceCm, litersPerCm);
}

void printReadings(float grams, float liters) {
  Serial.printf("Fertilizante: %.1f g   Agua: %.1f L   (nan = sin calibrar o sin sensor)\n", grams, liters);
}

// ===================== ENVÍO =====================
void sendReadings() {
  if (!selfTestOk) {
    Serial.println("Autoprueba fallida: no se envía nada. Escribe P para ver qué falla");
    return;
  }
  float grams = readFertilizerGrams();
  float liters = readWaterLiters();
  printReadings(grams, liters);

  char body[160];
  if (buildReadingsJson(body, sizeof(body), grams, liters) == 0) {
    Serial.println("Nada que enviar: calibra con T y C500, o V y L20");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Sin WiFi: no se envió");
    return;
  }

  String url = String(SERVER_URL) + "/api/readings";
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  // shortcut: no valida el certificado HTTPS; cuando el backend esté en Render, fijar su CA raíz con setCACert().
  secureClient.setInsecure();
  HTTPClient http;
  if (url.startsWith("https://")) http.begin(secureClient, url);
  else http.begin(plainClient, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  int status = http.POST(body);
  Serial.printf("POST %s -> %d\n", url.c_str(), status);  // negativo = no llegó al servidor
  http.end();
}

// ===================== CALIBRACIÓN =====================
void tareScale() {
  if (!scaleReady()) {
    Serial.println("La balanza no responde: revisa DT, SCK y la alimentación del HX711");
    return;
  }
  scale.tare(SCALE_SAMPLES);
  memoria.putLong("offset", scale.get_offset());
  Serial.println("Balanza en 0 g. Pon un peso conocido y escribe C<gramos>, ej. C500");
}

void calibrateScale(float knownGrams) {
  if (!memoria.isKey("offset")) {
    Serial.println("Primero T con el envase vacío");
    return;
  }
  if (!(knownGrams > 0)) {
    Serial.println("Uso: C500 (gramos del peso conocido)");
    return;
  }
  if (!scaleReady()) {
    Serial.println("La balanza no responde: revisa DT, SCK y la alimentación del HX711");
    return;
  }
  float counts = scale.get_value(SCALE_SAMPLES);  // lectura menos la tara
  float countsPerGram = counts / knownGrams;
  if (!(fabsf(counts) >= MIN_CALIBRATION_COUNTS) || !isfinite(countsPerGram)) {
    Serial.println("Casi no cambió la lectura: ¿pusiste el peso encima? No se guardó nada");
    return;
  }
  scale.set_scale(countsPerGram);
  memoria.putFloat("scale", countsPerGram);
  scaleCalibrated = true;
  Serial.printf("Balanza calibrada: marca %.1f g\n", readFertilizerGrams());
}

void setEmptyTank() {
  float distance = readDistanceCm();
  if (isnan(distance)) {
    Serial.println("Sin eco estable: revisa TRIG, ECHO y el divisor");
    return;
  }
  emptyDistanceCm = distance;
  memoria.putFloat("emptyCm", distance);
  litersPerCm = 0;  // el fondo cambió: la calibración de litros anterior ya no vale
  memoria.remove("litersPerCm");
  Serial.printf("Tanque vacío: fondo a %.1f cm. Llena una cantidad conocida y escribe L<litros>\n", distance);
}

void calibrateTank(float knownLiters) {
  float perCm = litersPerCmFrom(knownLiters, emptyDistanceCm, readDistanceCm());
  if (isnan(perCm)) {
    Serial.println("Uso: primero V con el tanque vacío, luego L20 con 20 litros dentro");
    return;
  }
  litersPerCm = perCm;
  memoria.putFloat("litersPerCm", perCm);
  Serial.printf("Tanque calibrado: %.2f L por cm\n", perCm);
}

// ===================== COMANDOS =====================
void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;
  char letter = toupper(cmd[0]);
  bool bare = cmd.length() == 1;  // T, V, E, S y P van solos: "tara" o "vaciar" no cuentan
  float value = cmd.substring(1).toFloat();

  if (letter == 'T' && bare) tareScale();
  else if (letter == 'C') calibrateScale(value);
  else if (letter == 'V' && bare) setEmptyTank();
  else if (letter == 'L') calibrateTank(value);
  else if (letter == 'E' && bare) printReadings(readFertilizerGrams(), readWaterLiters());
  else if (letter == 'S' && bare) sendReadings();
  else if (letter == 'P' && bare) selfTestOk = runSelfTest();
  else Serial.println("Comandos: T, C500, V, L20, E, S, P");
}

// ===================== INICIO =====================
void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT);

  selfTestOk = runSelfTest();

  memoria.begin("invernadero", false);
  scale.begin(PIN_HX711_DT, PIN_HX711_SCK, false, false);  // sin reset: no se cuelga si el HX711 no está
  scale.set_offset(memoria.getLong("offset", 0));
  float countsPerGram = memoria.getFloat("scale", 0);
  scaleCalibrated = isfinite(countsPerGram) && countsPerGram != 0;
  if (scaleCalibrated) scale.set_scale(countsPerGram);
  emptyDistanceCm = memoria.getFloat("emptyCm", 0);
  litersPerCm = memoria.getFloat("litersPerCm", 0);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) delay(250);
  if (WiFi.status() == WL_CONNECTED) Serial.printf("WiFi conectado: %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("Sin WiFi por ahora; sigue intentando solo");

  Serial.println("Comandos: T, C500, V, L20, E, S, P");
}

void loop() {
  if (Serial.available()) handleCommand(Serial.readStringUntil('\n'));
  if (millis() - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = millis();
    sendReadings();
  }
}
