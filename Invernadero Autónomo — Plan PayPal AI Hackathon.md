# Invernadero Autónomo — Plan PayPal AI Hackathon

Oct 27, 2026 · @Luhotekk · actualizado 28 oct 2026 (enfoque empresarial)

## Resumen

Un agente de compras para invernaderos comerciales. Sensores con ESP32 vigilan los insumos de varios invernaderos; un agente IA (Claude) predice cuándo se acaban, arma pedidos consolidados al mejor proveedor y paga con PayPal, respetando el presupuesto de cada invernadero y la cadena de aprobaciones de la empresa.

- **Problema:** en un invernadero grande, quedarse sin un insumo detiene la producción, y las compras se hacen tarde, desordenadas y sin control de quién aprobó qué.
- **Para quién:** empresas con invernaderos comerciales o industriales (varios invernaderos, varios insumos, un equipo con distintos roles), empezando por Ecuador.
- **Premios objetivo:** Best Use of Agentic Commerce, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Render. Sin descartar el top 3.
- **Avance real en el hackathon:** el proyecto anterior (`../Invernadero`) solo tenía diseño; todo el código se escribe durante el hackathon.

## Estado (28 oct)

- [x] Repo público con LICENSE MIT: https://github.com/luistech27/Hackathon
- [x] Lógica de predicción, elección de proveedor y reglas de presupuesto, con TDD (48 pruebas, 100% de cobertura)
- [x] PayPal Vault probado en Sandbox: método guardado y cobro de $1.00 COMPLETED sin el dueño presente
- [x] Firmware del ESP32 (balanza HX711 y ultrasónico) que compila para ESP32, S3 y C6
- [ ] Probar y calibrar el firmware en el hardware real
- [x] Render pagado con el código promocional de $50: servidor y Postgres en https://invernadero-api-jn3j.onrender.com
- [x] Login con los 4 roles, matriz de aprobación y presupuesto por invernadero, con TDD

## Requisitos de entrega

Se entrega en Devpost hasta el 12 de noviembre de 2026, 12:00 PST = **15:00 hora de Ecuador**. Apuntar a subir todo el 11 por la noche.

| Entregable | Qué exige |
| --- | --- |
| Proyecto | Usa de verdad PayPal (Sandbox) y una IA; prototipo funcionando |
| Descripción | Funciones del proyecto y qué IA se usó y cómo |
| Demo funcional | URL hospedada o instrucciones completas para correrlo; un mockup no vale |
| Repositorio | Público en GitHub, con todo el código, instrucciones y archivo LICENSE visible |
| Video | YouTube público, menos de 3 min, funcionando en el dispositivo real, sin música con copyright |

Criterios de los jueces: implementación técnica, diseño de producto completo, impacto real, innovación y presentación. Fuente: [Devpost](https://paypalaihackathon.devpost.com/).

## Arquitectura

1. **ESP32 por punto de almacenamiento** (cada tanque, bodega o silo), o el modo simulación: manda niveles a `POST /api/readings`.
2. **Backend Node + TypeScript en Render:** API, roles, reglas y órdenes de compra.
3. **Base de datos Postgres en Render** (con los créditos del hackathon).
4. **Agente con Claude:** corre cada pocos minutos (evaluar Render Workflows) y propone pedidos consolidados con su razonamiento.
5. **Reglas en código** (`server/src/domain`): presupuesto, matriz de aprobación y anti-fraccionamiento. Claude propone, el código decide.
6. **PayPal Sandbox:** Vault para pagar sin el aprobador presente y Orders API para cada compra.
7. **Dashboard web por rol:** niveles por invernadero, bandeja de aprobaciones, recepción de pedidos, historial y exportación.

Modelo de datos: Empresa (moneda) → Invernaderos (presupuesto mensual, encargado) → Insumos (unidad, dispositivo, consumo) · Proveedores y catálogo · Usuarios (rol, invernadero) · Órdenes de compra · Registro de auditoría.

## Roles y aprobaciones

Basado en cómo trabajan las áreas de compras: quien pide no aprueba, el monto decide quién aprueba, y todo queda registrado.

| Rol | Qué hace en el sistema |
| --- | --- |
| **Operador** (técnico) | Ve niveles y alertas de su invernadero; **confirma la recepción** de los pedidos |
| **Encargado de invernadero** | Aprueba pedidos de *su* invernadero hasta su límite |
| **Compras** | Maneja proveedores, catálogo y precios; **no aprueba pagos** |
| **Gerente** | Fija presupuestos, límites y modo del agente; aprueba lo que pasa el límite del encargado |

Matriz de aprobación (montos de ejemplo, configurables por el gerente):

| Pedido | Quién decide |
| --- | --- |
| Hasta $100 y dentro del presupuesto | El agente paga solo |
| De $100 a $500 | Encargado de ese invernadero (o gerente) |
| Más de $500 | Gerente |
| Pasa el presupuesto del mes | Nadie: se rechaza; solo el gerente puede subir el presupuesto |

Reglas de control:

- **Nadie aprueba fuera de su alcance:** el encargado solo su invernadero y hasta su límite; Compras nunca aprueba pagos.
- **Anti-fraccionamiento:** para la matriz cuenta la suma de pedidos al mismo proveedor en los últimos 7 días, así el agente no puede partir un pedido grande para pagarlo solo.
- **Recheque al aprobar:** al aprobar se vuelve a revisar el presupuesto con lo gastado en ese momento.
- **Auditoría:** cada acción guarda quién, qué, cuándo y el razonamiento del agente.

## Flujo del agente

1. **Lee:** niveles actuales de cada insumo en cada invernadero e historial de consumo.
2. **Predice:** días restantes según el ritmo de consumo.
3. **Decide:** si quedan menos días que la entrega del proveedor + margen, el insumo necesita pedido.
4. **Consolida:** agrupa los insumos que necesitan pedido por proveedor y por invernadero.
5. **Elige proveedor:** el más barato que llegue a tiempo; si ninguno llega, el más rápido.
6. **Pasa las reglas:** presupuesto, matriz de aprobación y anti-fraccionamiento. El monto se calcula desde el catálogo, nunca desde lo que diga la IA, y lo gastado se reserva en la misma transacción.
7. **Paga o pide aprobación:** si está bajo el límite paga con PayPal (Vault); si no, la orden va a la bandeja del encargado o del gerente con el razonamiento.
8. **Registra:** número de orden de compra, PayPal order ID, decisión y razonamiento en una frase.

## Contabilidad liviana

Versión simple de la conciliación de 3 documentos (three-way match) que usan las empresas:

1. **Orden de compra** con número propio (`OC-2026-0001`): invernadero, proveedor, ítems, cantidades, precios y total.
2. **Comprobante de pago:** la orden de PayPal (ID y estado).
3. **Recepción:** el operador confirma si llegó completo o cuánto faltó; si falta algo, la orden queda marcada para revisión.

Cada invernadero es un **centro de costo**: el dashboard muestra lo gastado frente al presupuesto y exporta un CSV por mes y por invernadero para el contador.

**Moneda:** una por empresa (USD por defecto, o cualquier otra que acepte PayPal). No se mezclan monedas.

## Integración PayPal Sandbox

Probado el 28 oct: el flujo de Vault funciona con la cuenta Sandbox de la app.

1. **Guardar método de pago (una vez, el gerente):** setup token con `usage_type: MERCHANT` → aprobación → payment token guardado en la base de datos. [Guía de PayPal](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal)
2. **Compra automática:** Orders API v2 con `payment_source.paypal.vault_id`; la orden vuelve `COMPLETED` directamente.
3. **Compra aprobada por una persona:** el aprobador aprueba en el dashboard y el backend cobra con el mismo `vault_id`.
4. Guardar cada `order_id` y su estado junto a la orden de compra.
5. Revisar el PayPal Agent Toolkit / MCP server por si suma para "Best Use of PayPal + AI", siempre detrás de las reglas de presupuesto.

## Modo simulación para jueces

Los jueces no tienen el ESP32, así que el dashboard hospedado usa el mismo backend y el mismo agente con datos simulados.

- **Empresa demo con 3 invernaderos:** uno recibe datos del ESP32 real y dos son simulados.
- Sliders para bajar niveles y un botón "acelerar tiempo" para simular días de consumo.
- Botón "Restablecer demo" que limpia historial, órdenes y presupuestos.
- **4 usuarios de prueba, uno por rol,** y una cuenta Sandbox de PayPal en el README.
- El agente y PayPal funcionan igual en ambos modos: solo cambia de dónde vienen los datos.

## Hardware

- Un ESP32 (normal, S3 o C6) por punto de almacenamiento, todos con el mismo firmware (`firmware/Invernadero`).
- Balanza HX711 para insumos sólidos y ultrasónico para tanques; calibración por Monitor Serie.
- Pendiente: que el nombre de cada insumo (por ejemplo `npk-bodega-1`) se configure por dispositivo en `secrets.h`.
- A futuro: sensores industriales (radar, 4-20 mA, balanzas de plataforma) mandando a la misma API.

## Cronograma

Quedan 15 días; la entrega queda lista el 11 de noviembre y el 12 es solo margen.

**28–30 oct · Hardware y base del backend**

- [ ] Conectar y calibrar balanza y ultrasónico en el ESP32 real (tú)
- [ ] Nombre de insumo configurable en el firmware
- [x] Backend en Render con Postgres: empresas, invernaderos, insumos, lecturas (`POST /api/readings` con clave de dispositivo)

**31 oct – 3 nov · Agente, roles y reglas**

- [x] Login con los 4 roles y permisos revisados en el servidor
- [x] Matriz de aprobación, anti-fraccionamiento y presupuesto por invernadero (TDD)
- [x] Catálogo de proveedores de prueba (lo maneja Compras)
- [x] Agente con Claude: predicción, consolidación por proveedor, elección y razonamiento

**4–6 nov · PayPal y órdenes de compra**

- [x] Guardar método de pago (Vault) desde el dashboard del gerente
- [x] Compra automática con `vault_id` y compra tras aprobación (probado en Sandbox el 29 oct)
- [ ] Órdenes de compra numeradas, recepción por el operador y registro de auditoría

**7–9 nov · Dashboard y simulación**

- [ ] Vista por invernadero: niveles, días restantes, presupuesto usado
- [ ] Bandeja de aprobaciones por rol, recepción e historial con razonamiento
- [ ] Exportación CSV por invernadero y mes
- [ ] Modo simulación con 3 invernaderos

**10 nov · Pruebas y README**

- [ ] Pruebas E2E del flujo completo (Playwright)
- [ ] README en inglés con instrucciones, usuarios de prueba y cuenta Sandbox

**11 nov · Video y entrega**

- [ ] Grabar y editar el video
- [ ] Subir a YouTube y llenar Devpost

**12 nov:** margen para errores; entregar antes de las 15:00.

## Guion del video (máx. 3 min)

| Tiempo | Qué se ve |
| --- | --- |
| 0:00–0:20 | El problema: empresa con varios invernaderos, insumos que se acaban y compras sin control |
| 0:20–0:45 | Hardware real (ESP32, balanza, tanque) y dashboard con los 3 invernaderos |
| 0:45–1:00 | El gerente fija presupuestos y límites, y aprueba PayPal una sola vez |
| 1:00–1:40 | Se retira fertilizante de la balanza; el agente predice, consolida el pedido y paga solo |
| 1:40–2:10 | Pedido grande: pasa el límite del encargado y el gerente lo aprueba en la app |
| 2:10–2:30 | El operador confirma la recepción; historial con OC, ID de PayPal y razonamiento; CSV |
| 2:30–3:00 | Impacto y lo que sigue |

Usar música libre de derechos o ninguna. Narración en inglés o subtítulos en inglés.

## Fuera de alcance (lo que sigue)

- Integración con un ERP (por ejemplo Odoo, que tiene API de compras e inventario)
- Escalamiento automático si nadie aprueba a tiempo
- Reclamos en PayPal (Disputes) cuando un pedido llega incompleto
- Proveedores en monedas distintas con conversión
- Sensores industriales y app Android

## Checklist final y riesgos

- [ ] Repo público con LICENSE visible y README en inglés
- [ ] URL del demo hospedado funcionando en modo simulación
- [ ] Usuarios de prueba por rol y cuenta Sandbox en el README
- [ ] Video público en YouTube, menos de 3 min
- [ ] Descripción en Devpost: problema, funciones, IA usada y cómo
- [ ] Sin claves secretas en el repo (variables de entorno en Render)

| Riesgo | Plan B |
| --- | --- |
| Vault no funciona en Sandbox | Resuelto: probado el 28 oct |
| Alcance grande (roles + contabilidad) | Recortar en este orden: CSV → anti-fraccionamiento → rol Compras (lo absorbe el gerente) |
| Créditos de Render no llegan | Plan gratis mientras; base de datos pagada solo si hace falta |
| Celda de carga inestable | Usar solo el ultrasónico del tanque |
| Render en plan gratis se duerme | Abrir la URL antes de grabar y avisar en el README |
| Se acaba el tiempo | Dashboard web basta; recortar según el orden de arriba |
