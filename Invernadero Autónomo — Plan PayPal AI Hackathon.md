# Invernadero Autónomo — Plan PayPal AI Hackathon

Oct 27, 2026 · @Luhotekk

## Resumen

Un invernadero con ESP32 que no solo se cuida solo: también se reabastece solo. Un agente IA detecta que se acaba el fertilizante o el agua de riego, decide qué comprar y a qué proveedor, y paga con PayPal sin pasarse del presupuesto que fijó el dueño.

- **Problema:** pequeños productores se quedan sin insumos en el peor momento y pierden cosecha o tiempo yendo a comprar.
- **Para quién:** agricultores pequeños y medianos con invernaderos, empezando por Santo Domingo, Ecuador.
- **Premios objetivo:** Best Use of Agentic Commerce, Best Demo Delivery, Best Use of PayPal + AI, Best Use of Render. Sin descartar el top 3.
- **Base existente:** proyecto de invernadero con ESP32 (app + dashboard web) que ya está en marcha. Las reglas permiten proyectos existentes si hay avance real durante el hackathon.

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

&#91;embedded content: arquitectura · 7 componentes\]

El ESP32 (o el modo simulación) manda lecturas al backend en Render; el agente con Claude decide y paga en PayPal Sandbox; el dashboard muestra todo y recibe las aprobaciones. Hardware nuevo: celda de carga HX711 y sensor ultrasónico, sumados a los sensores que ya tiene el invernadero.

## Flujo del agente y presupuesto

El agente compra solo por debajo del límite y pide aprobación por encima; nunca supera el presupuesto mensual.

1. **Lee:** niveles actuales (balanza de fertilizante, tanque) e historial de consumo.
2. **Predice:** días restantes de cada insumo según el ritmo de consumo y el clima del invernadero.
3. **Decide:** si quedan menos días que el tiempo de entrega del proveedor + margen, prepara un pedido.
4. **Elige proveedor:** compara precio, tiempo de entrega y cantidad mínima en el catálogo (la tienda de los papás puede ser un proveedor).
5. **Revisa reglas:**
   - Pedido ≤ monto máximo por pedido y cabe en el presupuesto del mes → paga solo.
   - Pedido mayor → manda solicitud de aprobación a la app con su razonamiento.
6. **Paga:** orden en PayPal con el método guardado.
7. **Registra:** guarda la decisión, el razonamiento en una frase y el ID de la orden en el historial visible del dashboard.

Reglas configurables por el dueño: presupuesto mensual, máximo por pedido, proveedores permitidos y modo (automático / siempre pedir aprobación).

## Integración PayPal Sandbox

La pieza clave es el Vault: el dueño aprueba su cuenta PayPal una vez y luego el agente puede cobrar sin que esté presente.

1. Crear cuenta en [PayPal Developer](https://developer.paypal.com) y dos cuentas Sandbox: negocio (proveedor) y personal (dueño del invernadero).
2. **Guardar método de pago:** setup token con `usage_type: MERCHANT` → el dueño aprueba → convertirlo en payment token y guardarlo en la base de datos. [Guía de PayPal](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal)
3. **Comprar sin el dueño presente:** Orders API v2 con `payment_source.paypal.vault_id` = el token guardado, luego capture.
4. **Compras que necesitan aprobación:** orden normal con botón PayPal en la app; el dueño aprueba y se captura.
5. Guardar cada `order_id` y su estado para mostrarlo en el historial.

Riesgo a validar el día 8: que el flujo de Vault funcione en Sandbox con la cuenta usada. Plan B: todas las compras con aprobación de un toque (sigue siendo agéntico: el agente arma y propone el pedido).

## Modo simulación para jueces

Los jueces no tienen el ESP32, así que el dashboard hospedado necesita un modo simulación que use el mismo backend y el mismo agente.

- Interruptor "Hardware real / Simulación" en el dashboard.
- Sliders para bajar el nivel de fertilizante y agua, y un botón "acelerar tiempo" para simular días de consumo.
- Botón "Restablecer demo" que limpia historial y presupuesto.
- Credenciales de una cuenta Sandbox de prueba en el README para que el juez apruebe pagos.
- El agente y PayPal funcionan igual en ambos modos: solo cambia de dónde vienen los datos.

## Cronograma

Cinco fases en 16 días; la entrega queda lista el 11 de noviembre y el 12 es solo margen.

**27 oct (hoy):** inscribirse en Devpost, crear cuenta PayPal Developer y cuentas Sandbox, crear el repo con LICENSE.

**28–30 oct · Hardware y datos**

- [ ] Celda de carga HX711 bajo el envase de fertilizante, calibrada en gramos
- [ ] Ultrasónico en el tanque, calibrado en litros
- [ ] ESP32 envía lecturas al backend cada pocos minutos

**31 oct – 3 nov · Backend y agente**

- [ ] Backend en Render con base de datos (lecturas, catálogo, reglas, historial)
- [ ] Catálogo de proveedores de prueba con precios y tiempos de entrega
- [ ] Agente con Claude: predicción, elección de proveedor y reglas de presupuesto

**4–7 nov · PayPal**

- [ ] Flujo de Vault (guardar método de pago)
- [ ] Compra automática con `vault_id`
- [ ] Compra con aprobación para pedidos grandes

**8–10 nov · Dashboard y simulación**

- [ ] Dashboard: niveles, días restantes, decisiones del agente, historial de órdenes, presupuesto usado
- [ ] Modo simulación
- [ ] README con instrucciones y cuenta Sandbox de prueba

**11 nov · Video y entrega**

- [ ] Grabar y editar el video
- [ ] Subir a YouTube y llenar Devpost

**12 nov:** margen para errores; entregar antes de las 15:00.

## Guion del video (máx. 3 min)

El video tiene que mostrar el ciclo completo con el hardware real: de envase casi vacío a orden pagada.

| Tiempo | Qué se ve |
| --- | --- |
| 0:00–0:20 | El problema: productor sin fertilizante en plena temporada |
| 0:20–0:45 | El invernadero real: ESP32, balanza, tanque, dashboard en vivo |
| 0:45–1:00 | El dueño fija presupuesto y aprueba PayPal una sola vez |
| 1:00–1:45 | Se retira fertilizante de la balanza; el agente predice días restantes, elige proveedor y paga solo |
| 1:45–2:15 | Pedido grande: el agente pide aprobación, el dueño aprueba en la app |
| 2:15–2:40 | Historial con el razonamiento del agente y las órdenes de PayPal |
| 2:40–3:00 | Impacto y cierre: para quién es y qué sigue |

Usar música libre de derechos o ninguna. Narración en inglés o subtítulos en inglés.

## Checklist final y riesgos

- [ ] Repo público con LICENSE visible y README en inglés
- [ ] URL del demo hospedado funcionando en modo simulación
- [ ] Video público en YouTube, menos de 3 min
- [ ] Descripción en Devpost: problema, funciones, IA usada y cómo
- [ ] Sin claves secretas en el repo (variables de entorno en Render)

| Riesgo | Plan B |
| --- | --- |
| Vault no funciona en Sandbox | Todas las compras con aprobación de un toque |
| Celda de carga inestable | Usar solo el ultrasónico del tanque |
| Render en plan gratis se duerme | Abrir la URL antes de grabar y avisar en el README |
| Se acaba el tiempo | Recortar la app Android; dashboard web basta |
