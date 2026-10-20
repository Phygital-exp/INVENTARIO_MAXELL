// ========== CONFIGURACIÓN DEL FRONT ==========
// Único lugar donde se definen las URLs del backend (proxy en Railway).
window.APP_CONFIG = {
    API_BASE_URL: "https://inventariomaxell-production.up.railway.app",

    RUTAS: {
        usuario: cedula => `/api/usuarios/${encodeURIComponent(cedula)}`,
        inventario: cedula => `/api/inventario/${encodeURIComponent(cedula)}`,
        guardarProducto: (cedula, productoId) =>
            `/api/inventario/${encodeURIComponent(cedula)}/productos/${encodeURIComponent(productoId)}`,
        enviar: cedula => `/api/inventario/${encodeURIComponent(cedula)}/enviar`,
    },

    // Tiempo máximo de espera por petición (ms)
    TIMEOUT_MS: 25000,
};
