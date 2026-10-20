const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

// ========== CONFIGURACIÓN (variables de entorno en Railway) ==========
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN;
const API_BASE_URL = (process.env.API_BASE_URL ||
    "https://botai.smartdataautomation.com/api_backend_ai/dinamic-db/report/119").replace(/\/+$/, "");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://phygital-exp.github.io")
    .split(",").map(o => o.trim().replace(/\/+$/, "")).filter(Boolean);

if (!API_TOKEN) {
    console.error("❌ Falta la variable de entorno API_TOKEN. Configúrala en Railway.");
    process.exit(1);
}

const AUTH_HEADERS = {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
};

const COLECCIONES = {
    usuarios: `${API_BASE_URL}/usuarios_demo_inv`,
    ingresos: `${API_BASE_URL}/ingreso_salida_demo_inv`,
    productos: `${API_BASE_URL}/productos_demo_inv`,
    registros: `${API_BASE_URL}/registro_inventario_demo_maxell`,
};

const ZONA_HORARIA = "America/Bogota";
const CANTIDAD_MAXIMA = 999999;
const ESTADO_EN_PUNTO = "EN PUNTO";
const PRODUCTO_ACTIVO = "ACTIVO";
const CATEGORIA_POR_DEFECTO = "SIN CATEGORÍA";

// Cuántos POST simultáneos se envían al enviar toda la encuesta
const ENVIOS_SIMULTANEOS = 5;

// ========== CORS: solo GitHub Pages (y los orígenes configurados) ==========
app.use(cors({
    origin(origin, callback) {
        // Peticiones sin origen (curl, health checks de Railway) se permiten
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
}));
app.use(express.json({ limit: "100kb" }));

// ========== UTILIDADES ==========
class ErrorApi extends Error {
    constructor(status, mensaje, extra = {}) {
        super(mensaje);
        this.status = status;
        this.extra = extra;
    }
}

// Envuelve los handlers async para que los errores lleguen al manejador central
const manejar = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ahora = () => new Date().toISOString();

const normalizarTexto = valor => String(valor ?? "").trim().replace(/\s+/g, " ");
const normalizarEstado = estado => normalizarTexto(estado).toUpperCase();

const soloDigitos = valor => /^\d+$/.test(String(valor ?? "").trim());
const mismoValor = (a, b) => a !== undefined && a !== null && String(a).trim() === String(b).trim();

// "2026-10-20T00:00:00" -> "2026-10-20"
const diaDe = fecha => String(fecha ?? "").slice(0, 10);

function validarCedula(valor) {
    const cedula = String(valor ?? "").trim();
    if (!soloDigitos(cedula)) throw new ErrorApi(400, "La cédula solo debe tener números.");
    return cedula;
}

function validarCantidad(valor, descripcion) {
    const texto = String(valor ?? "").trim();
    if (!/^\d+$/.test(texto) || Number(texto) > CANTIDAD_MAXIMA) {
        const sujeto = descripcion ? `La cantidad de ${descripcion}` : "La cantidad";
        throw new ErrorApi(400, `${sujeto} debe ser un número entero igual o mayor a 0.`);
    }
    return Number(texto);
}

// GET a una colección; la API permite filtrar por igualdad con query params (?CAMPO=valor)
async function consultarColeccion(url, filtros = {}) {
    const query = new URLSearchParams(filtros).toString();
    const destino = query ? `${url}?${query}` : url;
    const response = await fetch(destino, { headers: AUTH_HEADERS });
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ ${destino} respondió ${response.status}:`, errorBody);
        throw new ErrorApi(502, "No pudimos consultar la información. Intenta de nuevo.");
    }
    const data = await response.json();
    return Array.isArray(data.result) ? data.result : [];
}

// La API dinamic-db usa POST para todo:
//  - sin _id  -> crea el documento y responde { status: "ok", insert_id: "..." }
//  - con _id  -> actualiza ese documento; los campos deben llamarse EXACTAMENTE igual
//                que en la base, si no se crea un registro nuevo
async function enviarDocumento(url, doc) {
    const response = await fetch(url, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify(doc),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ POST ${url} respondió ${response.status}:`, errorBody);
        throw new ErrorApi(502, "No pudimos guardar la información. Intenta de nuevo.");
    }
    return response.json().catch(() => ({}));
}

async function crearDocumento(url, doc) {
    const { _id, ...sinId } = doc;
    const data = await enviarDocumento(url, sinId);
    return data && data.insert_id ? String(data.insert_id) : null;
}

async function actualizarDocumento(url, id, campos) {
    const data = await enviarDocumento(url, { _id: String(id), ...campos });
    if (data && data.insert_id && String(data.insert_id) !== String(id)) {
        console.warn(`⚠️ Se esperaba actualizar ${id} pero la API creó ${data.insert_id}. Revisa los nombres de campos.`);
    }
}

// Fecha sin hora ("2026-10-20T00:00:00", igual que FECHA_INGRESO) y hora aparte ("15:46:32"), en hora de Colombia
function fechaYHoraLocal() {
    const d = new Date();
    const dia = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA }).format(d);
    const hora = new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONA_HORARIA, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(d);
    return { FECHA: `${dia}T00:00:00`, HORA: hora };
}

const hoy = () => diaDe(fechaYHoraLocal().FECHA);

// Serializa las operaciones de una misma persona para no pisar cambios simultáneos
const bloqueos = new Map();
function conBloqueo(clave, fn) {
    const anterior = bloqueos.get(clave) || Promise.resolve();
    const actual = anterior.catch(() => {}).then(fn);
    const cola = actual.catch(() => {});
    bloqueos.set(clave, cola);
    cola.then(() => { if (bloqueos.get(clave) === cola) bloqueos.delete(clave); });
    return actual;
}

async function enParalelo(items, limite, fn) {
    let siguiente = 0;
    const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
        while (siguiente < items.length) await fn(items[siguiente++]);
    });
    await Promise.all(trabajadores);
}

// ========== PRODUCTOS (con caché corta: el catálogo cambia poco) ==========
// productos_demo_inv: { COD_BARRAS, REFERENCIA, DESCRIPCION, ESTADO, CATEGORIA, SUBCATEGORIA }
// Solo se inventarían los productos ACTIVO (o sin ESTADO)
const CACHE_PRODUCTOS_MS = 5 * 60 * 1000;
let cacheProductos = { datos: null, expira: 0 };

async function obtenerProductos() {
    if (cacheProductos.datos && Date.now() < cacheProductos.expira) return cacheProductos.datos;

    const crudos = await consultarColeccion(COLECCIONES.productos);
    const datos = crudos
        .filter(p => p._id && normalizarTexto(p.REFERENCIA))
        .filter(p => !normalizarEstado(p.ESTADO) || normalizarEstado(p.ESTADO) === PRODUCTO_ACTIVO)
        .map(p => ({
            PRODUCTO_ID: String(p._id),
            REFERENCIA: normalizarTexto(p.REFERENCIA),
            // Valor tal cual viene en la base (número), para guardarlo con el mismo tipo
            REFERENCIA_ORIGINAL: p.REFERENCIA,
            COD_BARRAS: normalizarTexto(p.COD_BARRAS),
            DESCRIPCION: normalizarTexto(p.DESCRIPCION),
            CATEGORIA: normalizarTexto(p.CATEGORIA).toUpperCase() || CATEGORIA_POR_DEFECTO,
            SUBCATEGORIA: normalizarTexto(p.SUBCATEGORIA),
        }))
        .sort((a, b) => a.CATEGORIA.localeCompare(b.CATEGORIA, "es")
            || a.SUBCATEGORIA.localeCompare(b.SUBCATEGORIA, "es")
            || a.DESCRIPCION.localeCompare(b.DESCRIPCION, "es"));

    cacheProductos = { datos, expira: Date.now() + CACHE_PRODUCTOS_MS };
    return datos;
}

async function obtenerProductoOError(productoId) {
    const producto = (await obtenerProductos()).find(p => p.PRODUCTO_ID === String(productoId));
    if (!producto) throw new ErrorApi(404, "Este producto no existe en el catálogo.");
    return producto;
}

// ========== USUARIOS E INGRESOS ==========
async function buscarUsuario(cedula) {
    const usuarios = await consultarColeccion(COLECCIONES.usuarios, { CEDULA: cedula });
    return usuarios.find(u => mismoValor(u.CEDULA, cedula)) || null;
}

// El bot registra en ingreso_salida_demo_inv cada ingreso al punto. Se toma el MÁS RECIENTE de hoy
// y debe estar "EN PUNTO"; si no, la persona no puede inventariar.
async function obtenerIngresoDeHoyOError(cedula) {
    const ingresos = await consultarColeccion(COLECCIONES.ingresos, { CEDULA: cedula });
    const ingreso = ingresos
        .filter(i => mismoValor(i.CEDULA, cedula) && diaDe(i.FECHA_INGRESO) === hoy())
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];

    if (!ingreso) {
        throw new ErrorApi(409, "No encontramos tu ingreso de hoy. Primero registra tu ingreso al punto en el bot.");
    }
    if (normalizarEstado(ingreso.ESTADO) !== ESTADO_EN_PUNTO) {
        throw new ErrorApi(409,
            `Tu ingreso de hoy aparece como "${normalizarTexto(ingreso.ESTADO) || "SIN ESTADO"}". ` +
            "Debes estar EN PUNTO para registrar inventario. Registra tu ingreso en el bot.");
    }
    return ingreso;
}

// ========== INVENTARIO (un documento por producto) ==========
// registro_inventario_demo_maxell:
// { CEDULA, NOMBRE, TELEFONO, PDV, SAP, REFERENCIA, DESCRIPCION, CANTIDAD, CATEGORIA, FECHA, HORA }

// Registros de la persona hoy en este punto (permite salir y retomar donde quedó)
async function registrosDeHoy(ingreso) {
    const docs = await consultarColeccion(COLECCIONES.registros, { CEDULA: ingreso.CEDULA });
    return docs.filter(d => mismoValor(d.CEDULA, ingreso.CEDULA)
        && diaDe(d.FECHA) === hoy()
        && mismoValor(d.SAP, ingreso.SAP ?? "")
        && normalizarTexto(d.REFERENCIA));
}

// REFERENCIA -> documento más reciente (por si quedara algún duplicado)
function registrosPorReferencia(docs) {
    const mapa = new Map();
    for (const d of docs) {
        const referencia = normalizarTexto(d.REFERENCIA);
        const previo = mapa.get(referencia);
        if (!previo || String(d.created || "") > String(previo.created || "")) mapa.set(referencia, d);
    }
    return mapa;
}

const tieneCantidad = doc => Boolean(doc) && doc.CANTIDAD !== null && doc.CANTIDAD !== ""
    && Number.isInteger(Number(doc.CANTIDAD)) && Number(doc.CANTIDAD) >= 0;

function nuevoRegistro(ingreso, producto, cantidad) {
    return {
        CEDULA: ingreso.CEDULA,
        NOMBRE: ingreso.NOMBRE ?? null,
        TELEFONO: ingreso.TELEFONO ?? null,
        PDV: ingreso.PDV ?? null,
        SAP: ingreso.SAP ?? null,
        REFERENCIA: producto.REFERENCIA_ORIGINAL,
        DESCRIPCION: producto.DESCRIPCION,
        CANTIDAD: cantidad,
        CATEGORIA: producto.CATEGORIA,
        ...fechaYHoraLocal(),
    };
}

// Respuesta al front: datos de la persona, punto y el catálogo con lo que ya diligenció
async function construirVista(ingreso, docs) {
    const catalogo = await obtenerProductos();
    const porReferencia = registrosPorReferencia(docs);

    const productos = catalogo.map(({ REFERENCIA_ORIGINAL, ...p }) => {
        const doc = porReferencia.get(p.REFERENCIA);
        return {
            ...p,
            CANTIDAD: tieneCantidad(doc) ? Number(doc.CANTIDAD) : null,
            REGISTRO_ID: doc ? String(doc._id) : null,
        };
    });
    const diligenciados = productos.filter(p => p.CANTIDAD !== null).length;

    return {
        usuario: {
            CEDULA: String(ingreso.CEDULA ?? ""),
            NOMBRE: ingreso.NOMBRE ?? null,
            TELEFONO: ingreso.TELEFONO ?? null,
        },
        punto: {
            PDV: ingreso.PDV ?? null,
            SAP: ingreso.SAP ?? null,
            CIUDAD: ingreso.CIUDAD ?? null,
            ESTADO: ingreso.ESTADO ?? null,
            FECHA_INGRESO: ingreso.FECHA_INGRESO ?? null,
        },
        categorias: [...new Set(catalogo.map(p => p.CATEGORIA))],
        productos,
        resumen: { total: productos.length, diligenciados, faltantes: productos.length - diligenciados },
    };
}

// Crea o edita la cantidad de un producto; devuelve los docs actualizados en memoria
async function guardarCantidad(ingreso, docs, producto, cantidad) {
    const existente = registrosPorReferencia(docs).get(producto.REFERENCIA);

    if (existente) {
        if (tieneCantidad(existente) && Number(existente.CANTIDAD) === cantidad) return docs;
        const cambios = { CANTIDAD: cantidad, HORA: fechaYHoraLocal().HORA };
        await actualizarDocumento(COLECCIONES.registros, existente._id, cambios);
        return docs.map(d => (d === existente ? { ...d, ...cambios } : d));
    }

    const nuevo = nuevoRegistro(ingreso, producto, cantidad);
    const insertId = await crearDocumento(COLECCIONES.registros, nuevo);
    return insertId
        ? [...docs, { _id: insertId, created: ahora(), ...nuevo }]
        : registrosDeHoy(ingreso); // respaldo si no llega insert_id
}

// ========== ENDPOINTS ==========

// Fase 1: validar cédula -> el front pregunta "¿Eres tú NOMBRE?"
app.get("/api/usuarios/:cedula", manejar(async (req, res) => {
    const cedula = validarCedula(req.params.cedula);
    console.log(`🔎 Validando cédula: ${cedula}`);

    const usuario = await buscarUsuario(cedula);
    if (!usuario) {
        return res.json({ existe: false, mensaje: "No encontramos usuarios con esa cédula. Por favor valídala e intenta de nuevo." });
    }
    res.json({ existe: true, usuario: { CEDULA: String(usuario.CEDULA), NOMBRE: usuario.NOMBRE ?? null } });
}));

// Fase 2 (confirmó "Sí, soy yo"): valida el ingreso de hoy EN PUNTO y devuelve productos + progreso.
// También sirve para retomar después de cerrar sesión.
app.get("/api/inventario/:cedula", manejar(async (req, res) => {
    const cedula = validarCedula(req.params.cedula);
    const ingreso = await obtenerIngresoDeHoyOError(cedula);
    const docs = await registrosDeHoy(ingreso);
    console.log(`📍 ${cedula} en ${ingreso.PDV} (SAP ${ingreso.SAP}) · ${docs.length} productos guardados hoy`);
    res.json({ inventario: await construirVista(ingreso, docs) });
}));

// Guardar o editar la cantidad de un producto (uno a uno)
app.put("/api/inventario/:cedula/productos/:productoId", manejar(async (req, res) => {
    const cedula = validarCedula(req.params.cedula);
    const producto = await obtenerProductoOError(req.params.productoId);
    const cantidad = validarCantidad(req.body && req.body.cantidad, producto.DESCRIPCION);

    const inventario = await conBloqueo(`cedula:${cedula}`, async () => {
        const ingreso = await obtenerIngresoDeHoyOError(cedula);
        const docs = await guardarCantidad(ingreso, await registrosDeHoy(ingreso), producto, cantidad);
        return construirVista(ingreso, docs);
    });

    console.log(`💾 ${cedula} · ${producto.REFERENCIA} = ${cantidad}`);
    res.json({ inventario });
}));

// Enviar toda la encuesta. Recibe { cantidades: [{ productoId, cantidad }] } con lo escrito en pantalla.
// Si falta algún producto responde 409 con la lista de faltantes y NO guarda nada.
app.post("/api/inventario/:cedula/enviar", manejar(async (req, res) => {
    const cedula = validarCedula(req.params.cedula);
    const lista = (req.body && req.body.cantidades) ?? [];
    if (!Array.isArray(lista)) throw new ErrorApi(400, "Los datos enviados no son válidos.");

    const catalogo = await obtenerProductos();
    const porId = new Map(catalogo.map(p => [p.PRODUCTO_ID, p]));
    const nuevas = new Map();
    for (const item of lista) {
        const producto = porId.get(String(item && item.productoId));
        if (!producto) throw new ErrorApi(400, "Uno de los productos enviados no existe en el catálogo.");
        nuevas.set(producto.PRODUCTO_ID, validarCantidad(item.cantidad, producto.DESCRIPCION));
    }

    const inventario = await conBloqueo(`cedula:${cedula}`, async () => {
        const ingreso = await obtenerIngresoDeHoyOError(cedula);
        let docs = await registrosDeHoy(ingreso);
        const porReferencia = registrosPorReferencia(docs);

        // Se revisan faltantes ANTES de escribir nada
        const faltantes = catalogo
            .filter(p => !nuevas.has(p.PRODUCTO_ID) && !tieneCantidad(porReferencia.get(p.REFERENCIA)))
            .map(({ PRODUCTO_ID, REFERENCIA, DESCRIPCION, CATEGORIA }) => ({ PRODUCTO_ID, REFERENCIA, DESCRIPCION, CATEGORIA }));
        if (faltantes.length > 0) {
            throw new ErrorApi(409, `Te faltan ${faltantes.length} productos por diligenciar.`, { faltantes });
        }

        // Solo se envía lo nuevo o lo que cambió
        const pendientes = catalogo.filter(p => {
            if (!nuevas.has(p.PRODUCTO_ID)) return false;
            const doc = porReferencia.get(p.REFERENCIA);
            return !tieneCantidad(doc) || Number(doc.CANTIDAD) !== nuevas.get(p.PRODUCTO_ID);
        });
        await enParalelo(pendientes, ENVIOS_SIMULTANEOS, async p => {
            const doc = porReferencia.get(p.REFERENCIA);
            const cantidad = nuevas.get(p.PRODUCTO_ID);
            if (doc) {
                await actualizarDocumento(COLECCIONES.registros, doc._id, { CANTIDAD: cantidad, HORA: fechaYHoraLocal().HORA });
            } else {
                await crearDocumento(COLECCIONES.registros, nuevoRegistro(ingreso, p, cantidad));
            }
        });
        console.log(`✅ ${cedula} · encuesta enviada (${pendientes.length} envíos)`);

        // Se relee para responder con lo que quedó realmente en la base
        docs = await registrosDeHoy(ingreso);
        return construirVista(ingreso, docs);
    });

    res.json({ inventario, enviado: inventario.resumen.faltantes === 0 });
}));

// ========== HEALTH CHECK ==========
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: ahora() });
});

// ========== 404 Y ERRORES ==========
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
    if (err instanceof ErrorApi) {
        return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Los datos enviados no son válidos." });
    }
    if (err.message && err.message.startsWith("Origen no permitido")) {
        return res.status(403).json({ error: err.message });
    }
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado. Intenta de nuevo." });
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy de inventario Maxell escuchando en puerto ${PORT}`);
    console.log(`🌐 CORS permitido para: ${ALLOWED_ORIGINS.join(", ")}`);
    console.log(`📍 Endpoints disponibles:`);
    console.log(`   - GET  /api/usuarios/:cedula`);
    console.log(`   - GET  /api/inventario/:cedula`);
    console.log(`   - PUT  /api/inventario/:cedula/productos/:productoId`);
    console.log(`   - POST /api/inventario/:cedula/enviar`);
    console.log(`   - GET  /health`);
});
