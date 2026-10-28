#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <algorithm>

// Conversiones puras, sin hardware: selftest.h las prueba al encender.
// Regla: ante la duda, NAN (no se envía). Un 0 falso le diría al agente "vacío" y compraría.

const float SOUND_CM_PER_US = 0.0343f;  // a 20 °C: calibra el tanque a la temperatura de trabajo
const float MIN_DISTANCE_CM = 2;        // más cerca es un eco falso (JSN-SR04T: no lo montes a menos de 25 cm del agua)
const float TANK_MARGIN_CM = 3;         // ruido aceptable por debajo del fondo
const float SCALE_NOISE_GRAMS = 20;     // ruido aceptable por debajo de 0 g

// Distancia (cm) a partir del tiempo de eco del ultrasónico: el sonido va y vuelve. 0 = sin eco válido.
inline float echoToCm(unsigned long echoUs) {
  float cm = echoUs * SOUND_CM_PER_US / 2;
  return cm >= MIN_DISTANCE_CM ? cm : 0;
}

// Mediana de las muestras válidas (> 0). Reordena el arreglo.
// NAN si menos de la mitad sirven: un eco suelto no basta para medir.
inline float medianOfValid(float* samples, size_t count) {
  float* validEnd = std::remove_if(samples, samples + count, [](float s) { return !(s > 0); });
  size_t valid = validEnd - samples;
  if (valid == 0 || valid * 2 < count) return NAN;
  std::sort(samples, validEnd);
  return valid % 2 ? samples[valid / 2] : (samples[valid / 2 - 1] + samples[valid / 2]) / 2;
}

// Litros en el tanque: el sensor mira hacia abajo desde la tapa, así que más agua = menos distancia.
// NAN si falta la lectura, si el tanque no está calibrado o si mide por debajo del fondo.
inline float litersFromDistance(float distanceCm, float emptyDistanceCm, float litersPerCm) {
  if (!(distanceCm > 0) || !(emptyDistanceCm > 0) || !(litersPerCm > 0)) return NAN;
  if (distanceCm > emptyDistanceCm + TANK_MARGIN_CM) return NAN;
  float liters = (emptyDistanceCm - distanceCm) * litersPerCm;
  return liters > 0 ? liters : 0;
}

// Calibración: con litros conocidos en el tanque, cuántos litros hay por cada cm de agua.
inline float litersPerCmFrom(float knownLiters, float emptyDistanceCm, float distanceCm) {
  float heightCm = emptyDistanceCm - distanceCm;
  if (!(heightCm > 0) || !(knownLiters > 0)) return NAN;
  return knownLiters / heightCm;
}

// Gramos de la balanza: el ruido cerca de 0 se deja en 0; muy negativo (envase quitado,
// cable suelto) o infinito es una lectura mala.
inline float gramsOrNan(float grams) {
  if (!isfinite(grams) || grams < -SCALE_NOISE_GRAMS) return NAN;
  return grams > 0 ? grams : 0;
}

// Cuerpo de POST /api/readings solo con las lecturas válidas; 0 si no hay ninguna.
inline size_t buildReadingsJson(char* out, size_t size, float fertilizerGrams, float waterLiters) {
  const char* ids[] = {"fertilizer", "water"};
  const float levels[] = {fertilizerGrams, waterLiters};
  JsonDocument doc;
  JsonArray readings = doc["readings"].to<JsonArray>();
  for (int i = 0; i < 2; i++) {
    if (!isfinite(levels[i])) continue;
    JsonObject reading = readings.add<JsonObject>();
    reading["supplyId"] = ids[i];
    reading["level"] = serialized(String(levels[i], 1));
  }
  return readings.size() > 0 ? serializeJson(doc, out, size) : 0;
}
