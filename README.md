# GeoTracker Server & Web Portal 🌐📍

Servidor de ingestión de telemetría GPS y Portal Web interactivo en tiempo real con mapas libres de OpenStreetMap, diseñado para despliegue instantáneo en **Coolify**, Docker o VPS tradicional.

---

## 🚀 Características Principales

* **Mapa Libre en Tiempo Real**: Visualización interactiva con **Leaflet.js** y **OpenStreetMap** (CartoDB Dark Matter) sin requerir tarjetas de crédito ni API Keys de Google Maps.
* **Multi-Dispositivo**: Detección y lista en vivo de todos los teléfonos Android conectados con indicador de estado (🟢 En línea / ⚪ Desconectado).
* **Trazado de Rutas Históricas**: Dibuja la línea de recorrido de las últimas horas o días, con velocidad, altitud y precisión por punto.
* **Seguridad & Login**: Autenticación protegida con JWT y cookies `HttpOnly`, con contraseñas encriptadas con `bcrypt`.
* **Base de Datos Flexible**:
  * **SQLite (Por defecto)**: Cero configuración, con modo WAL habilitado para alta concurrencia.
  * **MySQL / MariaDB**: Compatible directamente cambiando una sola variable de entorno (`DATABASE_URL`).
* **Ultra Rápido y Optimizado para Coolify**: Listo para desplegar mediante Dockerfile en menos de 1 minuto.

---

## 🐳 Despliegue en Coolify (Paso a Paso)

### Opción A: Despliegue desde Repositorio Git
1. En tu panel de **Coolify**, ve a tu proyecto y selecciona **+ New Resource > Public Repository** (o Private si está en tu GitHub/GitLab).
2. Pega la URL del repositorio donde subas esta carpeta `GeoTrackerServer`.
3. Coolify detectará automáticamente el archivo `Dockerfile`.
4. En la pestaña **Configuration > Environment Variables**, define (opcionalmente):
   ```env
   SECRET_KEY=clave_secreta_super_segura_para_jwt
   ADMIN_USER=admin
   ADMIN_PASSWORD=TuPasswordSeguro123
   DATABASE_URL=sqlite:////app/data/geotracker.db
   ```
   *(Si deseas usar MySQL en Coolify, simplemente agrega un servicio MySQL y coloca: `DATABASE_URL=mysql+pymysql://usuario:password@host_mysql:3306/geotracker`)*
5. En **Storages / Persistent Storage**, agrega un volumen persistente:
   * **Source Path:** Dejar por defecto generado por Coolify.
   * **Destination Path:** `/app/data` (para que la base de datos SQLite y los datos de las rutas nunca se pierdan al reiniciar el contenedor).
6. Haz clic en **Deploy**. ¡Listo! Coolify te asignará tu dominio con SSL HTTPS automático.

---

## 💻 Ejecución Local de Prueba (con Docker)

```bash
cd /home/lsilva/Documentos/Android/GeoTrackerServer
docker compose up -d --build
```
El portal estará disponible inmediatamente en:
👉 `http://localhost:8000`
* **Usuario:** `admin`
* **Contraseña:** `admin123`

---

## 📲 Conectar el APK de tu Celular a este Servidor

En la aplicación de tu celular (**GeoTracker**):
1. En el campo **Endpoint URL del VPS**, ingresa:
   ```
   https://tu-dominio-coolify.com/api/v1/telemetry
   ```
   *(O si pruebas localmente en la misma red WiFi: `http://IP_DE_TU_PC:8000/api/v1/telemetry`)*
2. Presiona **Guardar y Probar Conexión**.
3. El celular transmitirá automáticamente los lotes de coordenadas cada 5 minutos y podrás ver su ubicación y ruta en el mapa web en vivo.
