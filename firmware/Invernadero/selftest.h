#pragma once
#include <Arduino.h>
#include "levels.h"

// Autoprueba de las conversiones de levels.h (no usa sensores). Corre al encender y con P.
// Si falla, el ESP32 no envía lecturas.

inline bool near(float actual, float expected) {
  return fabsf(actual - expected) < 0.01f;
}

inline bool check(bool passed, const char* name) {
  if (!passed) Serial.printf("Autoprueba FALLÓ: %s\n", name);
  return passed;
}

inline bool runSelfTest() {
  float someMissing[] = {0, 20, 10, 30, 0};  // 0 = sin eco
  float evenCount[] = {10, 20};
  float oneEcho[] = {0, 0, 10, 0, 0};
  float noneValid[] = {0, 0, 0};
  char json[160];
  bool ok = true;

  ok &= check(near(medianOfValid(someMissing, 5), 20), "mediana ignora muestras sin eco");
  ok &= check(near(medianOfValid(evenCount, 2), 15), "mediana con cantidad par");
  ok &= check(isnan(medianOfValid(oneEcho, 5)), "un eco suelto no basta");
  ok &= check(isnan(medianOfValid(noneValid, 3)), "mediana sin muestras validas");
  ok &= check(near(echoToCm(583), 10), "eco a centimetros");
  ok &= check(echoToCm(50) == 0, "eco demasiado cerca es falso");

  ok &= check(near(litersFromDistance(30, 50, 2), 40), "litros desde distancia");
  ok &= check(near(litersFromDistance(52, 50, 2), 0), "ruido bajo el fondo = 0 L");
  ok &= check(isnan(litersFromDistance(60, 50, 2)), "muy por debajo del fondo es error");
  ok &= check(isnan(litersFromDistance(NAN, 50, 2)), "sin lectura no hay litros");
  ok &= check(isnan(litersFromDistance(30, 50, 0)), "tanque sin calibrar");
  ok &= check(isnan(litersFromDistance(30, 0, 2)), "tanque sin fondo guardado");
  ok &= check(near(litersPerCmFrom(20, 50, 40), 2), "calibracion litros por cm");
  ok &= check(isnan(litersPerCmFrom(20, 50, 50)), "calibracion sin agua");

  ok &= check(near(gramsOrNan(812.4f), 812.4f), "gramos normales");
  ok &= check(gramsOrNan(-5) == 0, "ruido bajo 0 g = 0 g");
  ok &= check(isnan(gramsOrNan(-500)), "muy negativo es error");
  ok &= check(isnan(gramsOrNan(NAN)) && isnan(gramsOrNan(INFINITY)), "gramos invalidos");

  buildReadingsJson(json, sizeof(json), 812.4f, NAN);
  ok &= check(strcmp(json, "{\"readings\":[{\"supplyId\":\"fertilizer\",\"level\":812.4}]}") == 0,
              "JSON solo con lecturas validas");
  ok &= check(buildReadingsJson(json, sizeof(json), NAN, NAN) == 0, "JSON vacio no se envia");
  ok &= check(buildReadingsJson(json, sizeof(json), INFINITY, NAN) == 0, "infinito no se envia");

  if (ok) Serial.println("Autoprueba OK");
  return ok;
}
