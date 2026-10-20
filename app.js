(() => {
    "use strict";

    const CFG = window.APP_CONFIG;
    const $ = id => document.getElementById(id);
    const CLAVE_SESION = "inventario_maxell_sesion";
    const MAX_FALTANTES_MODAL = 4;
    const MAX_DIGITOS = 6;
    const TODAS = "__TODAS__";

    // ========== ESTADO ==========
    const estado = {
        usuario: null,          // usuario encontrado en el paso 1 (antes de confirmar)
        cedula: null,           // cédula confirmada ("Sí, soy yo")
        inventario: null,       // respuesta del proxy (fuente de verdad de lo guardado)
        categoria: TODAS,
        filtro: "",
        soloPendientes: false,
        editando: new Set(),    // productos guardados que se están corrigiendo
        borradores: new Map(),  // valores escritos aún sin guardar
        guardando: new Set(),   // productos con envío en curso
    };

    // ========== API ==========
    class ErrorApi extends Error {
        constructor(mensaje, { status = 0, datos = null, red = false } = {}) {
            super(mensaje);
            this.status = status;
            this.datos = datos;
            this.red = red;
        }
    }

    async function api(ruta, { method = "GET", body } = {}) {
        const control = new AbortController();
        const temporizador = setTimeout(() => control.abort(), CFG.TIMEOUT_MS);
        let respuesta;
        try {
            respuesta = await fetch(CFG.API_BASE_URL + ruta, {
                method,
                headers: body ? { "Content-Type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: control.signal,
            });
        } catch (e) {
            throw new ErrorApi(
                e.name === "AbortError"
                    ? "El servidor está tardando mucho en responder. Revisa tu conexión e intenta de nuevo."
                    : "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.",
                { red: true }
            );
        } finally {
            clearTimeout(temporizador);
        }

        let datos = null;
        try { datos = await respuesta.json(); } catch (e) { /* respuesta sin JSON */ }

        if (!respuesta.ok) {
            throw new ErrorApi((datos && datos.error) || "Ocurrió un problema. Intenta de nuevo.", {
                status: respuesta.status, datos,
            });
        }
        return datos;
    }

    // ========== SESIÓN LOCAL (retomar si sale o recarga la página el mismo día) ==========
    const hoy = () => new Date().toLocaleDateString("en-CA");

    function guardarSesion() {
        if (!estado.cedula) return;
        try {
            localStorage.setItem(CLAVE_SESION, JSON.stringify({
                cedula: estado.cedula,
                dia: hoy(),
                borradores: Object.fromEntries(estado.borradores),
            }));
        } catch (e) { /* almacenamiento no disponible */ }
    }

    function leerSesion() {
        try {
            const s = JSON.parse(localStorage.getItem(CLAVE_SESION) || "null");
            return s && s.cedula && s.dia === hoy() ? s : null;
        } catch (e) {
            return null;
        }
    }

    function borrarSesion() {
        try { localStorage.removeItem(CLAVE_SESION); } catch (e) { /* nada */ }
    }

    // ========== UTILIDADES ==========
    const sinTildes = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

    function crear(etiqueta, props = {}, hijos = []) {
        const el = document.createElement(etiqueta);
        for (const [k, v] of Object.entries(props)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "for") el.setAttribute(k, v);
            else el[k] = v;
        }
        for (const h of [].concat(hijos)) if (h) el.append(h);
        return el;
    }

    const productos = () => (estado.inventario && estado.inventario.productos) || [];
    const productoPorId = id => productos().find(p => p.PRODUCTO_ID === id) || null;
    const estaGuardado = p => p && p.CANTIDAD !== null && p.CANTIDAD !== undefined;

    function vistaCargando(contenedor, texto) {
        contenedor.replaceChildren(crear("div", { class: "cargando", role: "status" }, [
            crear("div", { class: "spinner", "aria-hidden": "true" }),
            crear("p", { text: texto }),
        ]));
    }

    function aviso(contenedor, tipo, texto, botones = []) {
        contenedor.replaceChildren(crear("div", { class: `aviso aviso--${tipo}`, role: tipo === "error" ? "alert" : "status" }, [
            crear("p", { text: texto }),
            botones.length
                ? crear("div", { class: "aviso__botones" }, botones.map(b =>
                    crear("button", { class: `btn ${b.clase || "btn--secundario"}`, type: "button", text: b.texto, onclick: b.accion })))
                : null,
        ]));
    }

    function botonCargando(boton, cargando, textoCargando) {
        if (cargando) {
            boton.dataset.textoOriginal = boton.textContent;
            boton.disabled = true;
            boton.replaceChildren(crear("span", { class: "spinner spinner--sm", "aria-hidden": "true" }), textoCargando);
        } else {
            boton.disabled = false;
            boton.textContent = boton.dataset.textoOriginal || boton.textContent;
        }
    }

    // ========== TOASTS ==========
    function toast(texto, tipo = "exito", duracion = 2800) {
        const el = crear("div", { class: `toast toast--${tipo}`, role: tipo === "error" ? "alert" : "status", text: texto });
        $("toasts").append(el);
        setTimeout(() => {
            el.classList.add("saliendo");
            setTimeout(() => el.remove(), 300);
        }, duracion);
    }

    // ========== MODAL ==========
    let focoPrevio = null;

    function abrirModal({ titulo, cuerpo, botones }) {
        focoPrevio = document.activeElement;
        $("modal-titulo").textContent = titulo;
        $("modal-cuerpo").replaceChildren(...[].concat(cuerpo));
        $("modal-botones").replaceChildren(...botones.map(b =>
            crear("button", { class: `btn ${b.clase || "btn--secundario"}`, type: "button", text: b.texto, onclick: b.accion })
        ));
        $("modal").classList.remove("oculto");
        $("modal-botones").querySelector("button").focus();
    }

    function cerrarModal() {
        $("modal").classList.add("oculto");
        if (focoPrevio && document.contains(focoPrevio)) focoPrevio.focus();
    }

    $("modal").addEventListener("click", e => { if (e.target === $("modal")) cerrarModal(); });
    document.addEventListener("keydown", e => {
        if ($("modal").classList.contains("oculto")) return;
        if (e.key === "Escape") return cerrarModal();
        if (e.key === "Tab") {
            const enfocables = $("modal").querySelectorAll("button:not(:disabled)");
            const primero = enfocables[0], ultimo = enfocables[enfocables.length - 1];
            if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
            else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
        }
    });

    // ========== NAVEGACIÓN ENTRE PASOS ==========
    function mostrarPaso(n) {
        [1, 2, 3].forEach(i => $(`paso-${i}`).classList.toggle("oculto", i !== n));
        document.querySelectorAll(".pasos__item").forEach(li => {
            const paso = Number(li.dataset.paso);
            li.classList.toggle("activo", paso === n);
            li.classList.toggle("hecho", paso < n);
            if (paso === n) li.setAttribute("aria-current", "step");
            else li.removeAttribute("aria-current");
        });
        window.scrollTo({ top: 0 });
    }

    function actualizarEncabezado() {
        const inv = estado.inventario;
        $("sesion").classList.toggle("oculto", !inv);
        if (!inv) return;
        const u = inv.usuario || {};
        const pdv = inv.punto || {};
        $("sesion-nombre").textContent = u.NOMBRE || `Cédula ${u.CEDULA || ""}`;
        const partes = [pdv.PDV, pdv.SAP ? `SAP ${pdv.SAP}` : null, pdv.CIUDAD].filter(Boolean);
        $("sesion-pdv").textContent = partes.length ? `📍 ${partes.join(" · ")}` : "📍 Punto de venta no disponible";
    }

    // ========== PASO 1: IDENTIFICACIÓN ==========
    const inputCedula = $("cedula");

    inputCedula.addEventListener("input", () => {
        const limpio = inputCedula.value.replace(/\D/g, "");
        if (limpio !== inputCedula.value) inputCedula.value = limpio;
        inputCedula.classList.remove("invalido");
    });
    inputCedula.addEventListener("keydown", bloquearNoDigitos);

    function reiniciarPaso1() {
        estado.usuario = null;
        $("confirmacion").classList.add("oculto");
        $("form-cedula").classList.remove("oculto");
        $("mensaje-paso-1").replaceChildren();
        inputCedula.value = "";
        inputCedula.disabled = false;
        $("btn-buscar").disabled = false;
        mostrarPaso(1);
        inputCedula.focus();
    }

    $("form-cedula").addEventListener("submit", async e => {
        e.preventDefault();
        const cedula = inputCedula.value.trim();
        const mensaje = $("mensaje-paso-1");

        if (!/^\d+$/.test(cedula)) {
            inputCedula.classList.add("invalido");
            aviso(mensaje, "error", "Escribe tu número de cédula (solo números).");
            inputCedula.focus();
            return;
        }

        const boton = $("btn-buscar");
        botonCargando(boton, true, "Buscando…");
        inputCedula.disabled = true;
        mensaje.replaceChildren();

        try {
            const datos = await api(CFG.RUTAS.usuario(cedula));
            if (!datos || !datos.existe || !datos.usuario) {
                $("form-cedula").classList.add("oculto");
                aviso(mensaje, "error", "No se han encontrado usuarios con esa cédula. Por favor valídala e intenta de nuevo.", [
                    { texto: "Volver a ingresar la cédula", clase: "btn--primario", accion: reiniciarPaso1 },
                ]);
                mensaje.querySelector("button").focus();
                return;
            }
            estado.usuario = { ...datos.usuario, CEDULA: cedula };
            $("conf-nombre").textContent = datos.usuario.NOMBRE || `cédula ${cedula}`;
            $("form-cedula").classList.add("oculto");
            $("confirmacion").classList.remove("oculto");
            $("btn-si").focus();
        } catch (err) {
            inputCedula.disabled = false;
            aviso(mensaje, "error", err.message,
                err.red ? [{ texto: "Reintentar", accion: () => $("form-cedula").requestSubmit() }] : []);
        } finally {
            botonCargando(boton, false);
        }
    });

    $("btn-no").addEventListener("click", reiniciarPaso1);

    $("btn-si").addEventListener("click", async () => {
        const boton = $("btn-si");
        botonCargando(boton, true, "Validando tu ingreso…");
        $("btn-no").disabled = true;
        const ok = await abrirInventario(estado.usuario.CEDULA);
        botonCargando(boton, false);
        $("btn-no").disabled = false;
        if (ok) $("confirmacion").classList.add("oculto");
    });

    // Fase 2: valida el ingreso de hoy EN PUNTO y trae productos + lo ya guardado
    async function abrirInventario(cedula, borradoresPrevios = {}) {
        const mensaje = $("mensaje-paso-1");
        try {
            const datos = await api(CFG.RUTAS.inventario(cedula));
            estado.cedula = cedula;
            estado.inventario = datos.inventario;
            estado.borradores = new Map(Object.entries(borradoresPrevios)
                .filter(([id, v]) => productoPorId(id) && /^\d+$/.test(String(v))));
            guardarSesion();
            mensaje.replaceChildren();
            actualizarEncabezado();
            irAInventario();
            return true;
        } catch (err) {
            $("confirmacion").classList.add("oculto");
            $("form-cedula").classList.add("oculto");
            mostrarPaso(1);
            aviso(mensaje, "error", err.message, [
                { texto: "Intentar de nuevo", clase: "btn--primario", accion: () => reintentarInventario(cedula, borradoresPrevios) },
                { texto: "Cambiar cédula", accion: () => { borrarSesion(); reiniciarPaso1(); } },
            ]);
            return false;
        }
    }

    function reintentarInventario(cedula, borradoresPrevios) {
        vistaCargando($("mensaje-paso-1"), "Validando tu ingreso…");
        abrirInventario(cedula, borradoresPrevios);
    }

    // ========== PASO 2: INVENTARIO ==========
    function irAInventario() {
        mostrarPaso(2);
        renderInventario();
    }

    function renderInventario() {
        const cats = (estado.inventario && estado.inventario.categorias) || [];
        if (estado.categoria !== TODAS && !cats.includes(estado.categoria)) estado.categoria = TODAS;
        renderCategorias();
        renderLista();
        actualizarContador();
    }

    function conteoCategoria(categoria) {
        const lista = productos().filter(p => categoria === TODAS || p.CATEGORIA === categoria);
        return { total: lista.length, guardados: lista.filter(estaGuardado).length };
    }

    function renderCategorias() {
        const cats = [TODAS, ...((estado.inventario && estado.inventario.categorias) || [])];
        $("categorias").replaceChildren(...cats.map(c => {
            const { total, guardados } = conteoCategoria(c);
            const activa = estado.categoria === c;
            return crear("button", {
                class: `chip${activa ? " chip--activo" : ""}${total > 0 && guardados === total ? " chip--completo" : ""}`,
                type: "button", "aria-pressed": String(activa), "data-categoria": c,
                text: `${c === TODAS ? "Todas" : c} (${guardados}/${total})`,
            });
        }));
    }

    $("categorias").addEventListener("click", e => {
        const chip = e.target.closest("button[data-categoria]");
        if (!chip) return;
        estado.categoria = chip.dataset.categoria;
        renderCategorias();
        renderLista();
    });

    function actualizarContador() {
        const { total, guardados } = conteoCategoria(TODAS);
        const faltan = total - guardados;
        $("contador-texto").textContent = faltan === 0
            ? `✓ Guardaste los ${total} productos`
            : `Guardados ${guardados} de ${total} · Te faltan ${faltan}`;
        $("contador-barra").style.width = total ? `${(guardados / total) * 100}%` : "0";
        $("aviso-completo").classList.toggle("oculto", !(total > 0 && faltan === 0));
        renderCategorias();
    }

    function productosFiltrados() {
        const f = sinTildes(estado.filtro.trim());
        return productos().filter(p => {
            if (estado.categoria !== TODAS && p.CATEGORIA !== estado.categoria) return false;
            if (estado.soloPendientes && estaGuardado(p) && !estado.editando.has(p.PRODUCTO_ID)) return false;
            if (!f) return true;
            return sinTildes(p.DESCRIPCION).includes(f)
                || String(p.REFERENCIA).includes(f)
                || String(p.COD_BARRAS || "").includes(f)
                || sinTildes(p.SUBCATEGORIA).includes(f);
        });
    }

    function renderLista() {
        const lista = $("lista-productos");
        if (productos().length === 0) {
            lista.replaceChildren(crear("p", { class: "sin-resultados", text: "No hay productos para inventariar." }));
            $("barra-enviar").classList.add("oculto");
            return;
        }
        $("barra-enviar").classList.remove("oculto");

        const visibles = productosFiltrados();
        if (visibles.length === 0) {
            const texto = estado.soloPendientes && !estado.filtro.trim()
                ? "🎉 No tienes productos pendientes en esta categoría."
                : `No hay productos que coincidan con «${estado.filtro.trim()}».`;
            lista.replaceChildren(crear("p", { class: "sin-resultados", text: texto }));
            return;
        }
        lista.replaceChildren(...visibles.map(crearFila));
    }

    function crearFila(p) {
        const id = p.PRODUCTO_ID;
        const guardado = estaGuardado(p);
        const editando = estado.editando.has(id);
        const guardando = estado.guardando.has(id);

        const tipo = editando ? "editando" : guardado ? "guardado" : "pendiente";
        const etiquetas = { editando: "Corrigiendo", guardado: "✓ Guardado", pendiente: "Pendiente" };

        const valor = tipo !== "guardado" && estado.borradores.has(id)
            ? estado.borradores.get(id)
            : guardado ? String(p.CANTIDAD) : "";

        const input = crear("input", {
            id: `cant-${id}`, class: "campo cantidad", type: "text", inputMode: "numeric",
            autocomplete: "off", maxLength: MAX_DIGITOS, placeholder: "Cantidad", value: valor,
            disabled: tipo === "guardado" || guardando,
            "data-id": id,
        });
        input.setAttribute("pattern", "[0-9]*");

        const acciones = [];
        if (tipo === "guardado") {
            acciones.push(crear("button", {
                class: "btn btn--secundario btn-fila", type: "button", text: "✏️ Editar",
                "data-accion": "editar", "data-id": id, "aria-label": `Editar cantidad de ${p.DESCRIPCION}`,
            }));
        } else {
            const guardar = crear("button", {
                class: "btn btn--exito btn-fila", type: "button", "data-accion": "guardar", "data-id": id,
                "aria-label": `Guardar cantidad de ${p.DESCRIPCION}`, disabled: guardando,
            });
            if (guardando) guardar.append(crear("span", { class: "spinner spinner--sm", "aria-hidden": "true" }), "Guardando…");
            else guardar.textContent = "✔ Guardar";
            acciones.push(guardar);
            if (tipo === "editando" && !guardando) {
                acciones.push(crear("button", {
                    class: "btn btn--secundario btn-cancelar", type: "button", text: "✕",
                    "data-accion": "cancelar", "data-id": id, "aria-label": `Cancelar corrección de ${p.DESCRIPCION}`, title: "Cancelar",
                }));
            }
        }

        const codigos = [`Ref ${p.REFERENCIA}`, p.COD_BARRAS ? `Cód ${p.COD_BARRAS}` : null].filter(Boolean).join(" · ");

        return crear("div", { class: `fila fila--${tipo}`, role: "listitem", "data-id": id }, [
            crear("div", { class: "fila__info" }, [
                crear("p", { class: "fila__desc", text: p.DESCRIPCION || `Referencia ${p.REFERENCIA}` }),
                crear("p", { class: "fila__codigo", text: codigos }),
                crear("div", { class: "fila__etiquetas" }, [
                    crear("span", { class: "etiqueta-estado", text: etiquetas[tipo] }),
                    p.SUBCATEGORIA ? crear("span", { class: "etiqueta-sub", text: p.SUBCATEGORIA }) : null,
                ]),
            ]),
            crear("div", { class: "fila__cantidad" }, [
                crear("label", { for: `cant-${id}`, class: "sr-only", text: `Cantidad de ${p.DESCRIPCION}` }),
                input,
            ]),
            crear("div", { class: "fila__accion" }, acciones),
        ]);
    }

    function refrescarFila(id) {
        const actual = $("lista-productos").querySelector(`.fila[data-id="${id}"]`);
        const p = productoPorId(id);
        if (!actual || !p) return null;
        const nueva = crearFila(p);
        actual.replaceWith(nueva);
        return nueva;
    }

    // Solo enteros >= 0: bloquea cualquier carácter que no sea dígito (e, -, +, ., , etc.)
    function bloquearNoDigitos(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key && e.key.length === 1 && !/\d/.test(e.key)) e.preventDefault();
    }

    function limpiarCantidad(texto) {
        return String(texto).replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, MAX_DIGITOS);
    }

    const lista = $("lista-productos");

    lista.addEventListener("keydown", e => {
        if (!e.target.classList.contains("cantidad")) return;
        if (e.key === "Enter") {
            e.preventDefault();
            guardarCantidad(e.target.dataset.id);
            return;
        }
        bloquearNoDigitos(e);
    });

    // Cubre escritura, pegado y autocompletado del teclado del celular
    lista.addEventListener("input", e => {
        if (!e.target.classList.contains("cantidad")) return;
        const limpio = limpiarCantidad(e.target.value);
        if (limpio !== e.target.value) e.target.value = limpio;
        e.target.classList.remove("invalido");
        if (limpio === "") estado.borradores.delete(e.target.dataset.id);
        else estado.borradores.set(e.target.dataset.id, limpio);
        guardarSesion();
    });

    lista.addEventListener("click", e => {
        const boton = e.target.closest("button[data-accion]");
        if (!boton) return;
        const id = boton.dataset.id;
        if (boton.dataset.accion === "guardar") guardarCantidad(id);
        else if (boton.dataset.accion === "editar") editarCantidad(id);
        else if (boton.dataset.accion === "cancelar") cancelarEdicion(id);
    });

    function editarCantidad(id) {
        const p = productoPorId(id);
        estado.editando.add(id);
        estado.borradores.set(id, estaGuardado(p) ? String(p.CANTIDAD) : "");
        const fila = refrescarFila(id);
        const input = fila && fila.querySelector(".cantidad");
        if (input) { input.focus(); input.select(); }
    }

    function cancelarEdicion(id) {
        estado.editando.delete(id);
        estado.borradores.delete(id);
        guardarSesion();
        refrescarFila(id);
    }

    async function guardarCantidad(id) {
        if (estado.guardando.has(id)) return;
        const producto = productoPorId(id);
        const valor = limpiarCantidad(estado.borradores.get(id) || "");

        if (valor === "") {
            const input = $(`cant-${id}`);
            if (input) { input.classList.add("invalido"); input.focus(); }
            toast("Escribe la cantidad antes de guardar (usa 0 si no hay unidades).", "aviso");
            return;
        }

        estado.guardando.add(id);
        refrescarFila(id);

        try {
            const datos = await api(CFG.RUTAS.guardarProducto(estado.cedula, id), {
                method: "PUT",
                body: { cantidad: Number(valor) },
            });
            estado.inventario = datos.inventario;
            estado.editando.delete(id);
            estado.borradores.delete(id);
            estado.guardando.delete(id);
            guardarSesion();
            refrescarFila(id);
            actualizarContador();
            toast(`Guardado: ${producto ? producto.DESCRIPCION : "producto"} = ${valor}`, "exito");
            enfocarSiguientePendiente(id);
        } catch (err) {
            estado.guardando.delete(id);
            refrescarFila(id);
            toast(err.message, "error", 4500);
            if (err.status === 409) sesionInvalida(err.message);
        }
    }

    function enfocarSiguientePendiente(idActual) {
        const filas = [...lista.querySelectorAll(".fila")];
        const desde = filas.findIndex(f => f.dataset.id === idActual);
        const siguiente = filas.slice(desde + 1).find(f => f.classList.contains("fila--pendiente"));
        const input = siguiente && siguiente.querySelector(".cantidad");
        if (input) input.focus({ preventScroll: false });
    }

    // El ingreso dejó de ser válido (p. ej. salió del punto): vuelve al inicio sin perder lo escrito
    function sesionInvalida(mensaje) {
        abrirModal({
            titulo: "No puedes seguir registrando",
            cuerpo: crear("p", { text: mensaje }),
            botones: [{ texto: "Entendido", clase: "btn--primario", accion: () => {
                cerrarModal();
                estado.inventario = null;
                actualizarEncabezado();
                reiniciarPaso1();
            } }],
        });
    }

    $("buscador").addEventListener("input", e => {
        estado.filtro = e.target.value;
        renderLista();
    });

    $("solo-pendientes").addEventListener("change", e => {
        estado.soloPendientes = e.target.checked;
        renderLista();
    });

    // ========== ENVIAR TODA LA ENCUESTA ==========
    // Cantidades escritas en pantalla que aún no se han guardado (o que cambian lo guardado)
    function cantidadesSinGuardar() {
        const sinGuardar = [];
        for (const p of productos()) {
            const borrador = limpiarCantidad(estado.borradores.get(p.PRODUCTO_ID) || "");
            if (borrador === "") continue;
            if (estaGuardado(p) && p.CANTIDAD === Number(borrador)) continue;
            sinGuardar.push({ productoId: p.PRODUCTO_ID, cantidad: Number(borrador) });
        }
        return sinGuardar;
    }

    $("btn-enviar").addEventListener("click", () => {
        if (estado.guardando.size > 0) {
            toast("Espera un momento a que terminen de guardarse las cantidades.", "aviso", 3500);
            return;
        }

        const sinGuardar = cantidadesSinGuardar();
        const conValor = new Set(sinGuardar.map(c => c.productoId));
        const faltantes = productos().filter(p => !estaGuardado(p) && !conValor.has(p.PRODUCTO_ID));
        if (faltantes.length > 0) return modalFaltantes(faltantes);

        const n = sinGuardar.length;
        const texto = n > 0
            ? `Se ${n === 1 ? "guardará 1 cantidad que escribiste y aún no habías guardado" : `guardarán ${n} cantidades que escribiste y aún no habías guardado`}. ¿Confirmas el envío de la encuesta?`
            : `Registraste los ${productos().length} productos. ¿Confirmas el envío de la encuesta?`;

        abrirModal({
            titulo: "¿Enviar la encuesta?",
            cuerpo: crear("p", { text: texto }),
            botones: [
                { texto: "Sí, enviar", clase: "btn--primario", accion: e => confirmarEnvio(e.currentTarget, sinGuardar) },
                { texto: "Cancelar", accion: cerrarModal },
            ],
        });
    });

    function modalFaltantes(faltantes) {
        const n = faltantes.length;
        const items = faltantes.slice(0, MAX_FALTANTES_MODAL).map(p => crear("li", { text: p.DESCRIPCION || `Ref ${p.REFERENCIA}` }));
        const cuerpo = [
            crear("p", { text: "No puedes enviar la encuesta hasta escribir la cantidad de todos los productos. Te faltan:" }),
            crear("ul", {}, items),
        ];
        if (n > MAX_FALTANTES_MODAL) cuerpo.push(crear("p", { class: "modal__mas", text: `…y ${n - MAX_FALTANTES_MODAL} más` }));

        abrirModal({
            titulo: `Te ${n === 1 ? "falta 1 producto" : `faltan ${n} productos`}`,
            cuerpo,
            botones: [
                { texto: "Ir al producto que falta", clase: "btn--primario", accion: () => { cerrarModal(); irAProducto(faltantes[0].PRODUCTO_ID); } },
                { texto: "Cancelar", accion: cerrarModal },
            ],
        });
    }

    // Lleva y resalta un producto (quitando filtros si lo ocultan)
    function irAProducto(id) {
        let fila = lista.querySelector(`.fila[data-id="${id}"]`);
        if (!fila) {
            estado.filtro = "";
            estado.categoria = TODAS;
            estado.soloPendientes = false;
            $("buscador").value = "";
            $("solo-pendientes").checked = false;
            renderCategorias();
            renderLista();
            fila = lista.querySelector(`.fila[data-id="${id}"]`);
        }
        if (!fila) return;
        fila.scrollIntoView({ behavior: "smooth", block: "center" });
        fila.classList.remove("fila--resaltada");
        void fila.offsetWidth; // reinicia la animación
        fila.classList.add("fila--resaltada");
        const input = fila.querySelector(".cantidad:not(:disabled)");
        if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
    }

    async function confirmarEnvio(boton, cantidades) {
        botonCargando(boton, true, "Enviando…");
        $("modal-botones").querySelectorAll("button").forEach(b => { b.disabled = true; });

        try {
            const datos = await api(CFG.RUTAS.enviar(estado.cedula), {
                method: "POST",
                body: { cantidades },
            });
            estado.inventario = datos.inventario;
            estado.editando.clear();
            estado.borradores.clear();
            guardarSesion();
            cerrarModal();
            mostrarFinal();
        } catch (err) {
            cerrarModal();
            if (err.status === 409 && err.datos && Array.isArray(err.datos.faltantes)) {
                await recargarInventario();
                modalFaltantes(err.datos.faltantes);
            } else if (err.status === 409) {
                sesionInvalida(err.message);
            } else {
                toast(err.message, "error", 4500);
            }
        }
    }

    async function recargarInventario() {
        try {
            const datos = await api(CFG.RUTAS.inventario(estado.cedula));
            estado.inventario = datos.inventario;
            renderInventario();
        } catch (e) { /* se mantiene el inventario local */ }
    }

    // ========== PASO 3: ENVÍO ==========
    function mostrarFinal() {
        const inv = estado.inventario;
        const pdv = (inv && inv.punto) || {};
        const total = productos().length;
        $("final-resumen").textContent =
            `Registraste ${total} ${total === 1 ? "producto" : "productos"}${pdv.PDV ? ` en ${pdv.PDV}` : ""}. ¡Gracias!`;
        mostrarPaso(3);
        $("btn-salir-final").focus();
    }

    $("btn-revisar").addEventListener("click", irAInventario);
    $("btn-salir-final").addEventListener("click", salir);

    // ========== SALIR ==========
    function salir() {
        estado.cedula = null;
        estado.inventario = null;
        estado.categoria = TODAS;
        estado.filtro = "";
        estado.soloPendientes = false;
        estado.editando.clear();
        estado.borradores.clear();
        $("buscador").value = "";
        $("solo-pendientes").checked = false;
        borrarSesion();
        actualizarEncabezado();
        reiniciarPaso1();
    }

    $("btn-salir").addEventListener("click", () => {
        const pendientes = cantidadesSinGuardar().length;
        if (pendientes === 0) return salir();
        abrirModal({
            titulo: "Tienes cantidades sin guardar",
            cuerpo: crear("p", {
                text: `Escribiste ${pendientes === 1 ? "1 cantidad que no has guardado" : `${pendientes} cantidades que no has guardado`}. ` +
                    "Si sales ahora se perderán. Lo que ya guardaste sí queda registrado y podrás seguir al volver a entrar.",
            }),
            botones: [
                { texto: "Seguir registrando", clase: "btn--primario", accion: cerrarModal },
                { texto: "Salir de todas formas", accion: () => { cerrarModal(); salir(); } },
            ],
        });
    });

    // ========== INICIO: retomar sesión del día si existe ==========
    async function iniciar() {
        mostrarPaso(1);
        const sesion = leerSesion();
        if (!sesion) {
            inputCedula.focus();
            return;
        }

        $("form-cedula").classList.add("oculto");
        vistaCargando($("mensaje-paso-1"), "Recuperando tu progreso…");
        await abrirInventario(sesion.cedula, sesion.borradores || {});
    }

    iniciar();
})();
