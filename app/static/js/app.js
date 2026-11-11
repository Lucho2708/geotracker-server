// Estado Global de la Aplicación
let map = null;
let currentPolyline = null;
let currentMarkersGroup = null;
let routeEndpointsGroup = null;
let selectedDeviceId = null;
let devicesCache = [];
let autoRefreshTimer = null;
let currentFilterMode = 'quick'; // 'quick' o 'date'

// Inicialización del Mapa Leaflet
function initMap() {
    // 1. Capa Oscura (OSM con filtro dark)
    const darkLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        className: 'osm-dark-tiles'
    });

    // 2. Capa Satélite HD (Esri World Imagery - Libre de alta resolución)
    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: '&copy; Esri World Imagery'
    });

    // 3. Capa Callejero Detallado (Esri World Street Map)
    const streetLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: '&copy; Esri Streets'
    });

    map = L.map('map', {
        zoomControl: true,
        attributionControl: true,
        layers: [darkLayer]
    }).setView([4.6097, -74.0817], 13);

    // Selector de Capas Interactivo en la esquina superior derecha
    const baseMaps = {
        "🌑 Modo Oscuro": darkLayer,
        "🛰️ Satélite HD": satelliteLayer,
        "🗺️ Calles Esri": streetLayer
    };
    L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

    currentMarkersGroup = L.layerGroup().addTo(map);
    routeEndpointsGroup = L.layerGroup().addTo(map);
}

// Cargar Dispositivos desde el API
async function loadDevices() {
    try {
        const res = await fetch('/api/v1/devices');
        if (res.status === 401) {
            window.location.href = '/login';
            return;
        }
        devicesCache = await res.json();
        renderDeviceList(devicesCache);
        renderDeviceMarkers(devicesCache);

        // Si hay un dispositivo seleccionado, refrescamos su ruta
        if (selectedDeviceId) {
            const dev = devicesCache.find(d => d.id === selectedDeviceId);
            if (dev) {
                updateTelemetryBox(dev);
                loadRoute(selectedDeviceId, false);
            }
        } else if (devicesCache.length > 0) {
            // Seleccionar automáticamente el primero si ninguno está seleccionado
            selectDevice(devicesCache[0].id);
        }
    } catch (e) {
        console.error("Error cargando dispositivos:", e);
    }
}

// Dibujar lista en el Sidebar
function renderDeviceList(devices) {
    const container = document.getElementById('deviceList');
    const counter = document.getElementById('deviceCounter');
    counter.innerText = `${devices.length} Móvil${devices.length === 1 ? '' : 'es'}`;

    if (devices.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 px-4 text-slate-500 text-xs">
                <svg class="w-10 h-10 mx-auto mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
                </svg>
                No hay celulares registrados aún.<br>
                Configura la URL de este servidor en el APK para empezar a recibir coordenadas.
            </div>
        `;
        return;
    }

    container.innerHTML = devices.map(dev => {
        const isSelected = dev.id === selectedDeviceId;
        const timeAgo = formatTimeAgo(new Date(dev.last_seen));
        const statusClass = dev.is_online ? 'bg-emerald-500' : 'bg-slate-500';
        const statusText = dev.is_online ? 'En línea' : 'Desconectado';

        return `
            <div onclick="selectDevice('${dev.id}')"
                class="p-3 rounded-xl cursor-pointer transition-all ${
                    isSelected ? 'bg-sky-500/10 border border-sky-500/40 text-white' : 'hover:bg-slate-800/60 text-slate-300 border border-transparent'
                }">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-2.5 truncate">
                        <span class="w-2.5 h-2.5 rounded-full ${statusClass} flex-shrink-0"></span>
                        <span class="font-semibold text-sm truncate">${escapeHtml(dev.name || dev.id)}</span>
                    </div>
                    <div class="flex items-center space-x-1">
                        <button onclick="event.stopPropagation(); renameDevice('${dev.id}', '${escapeHtml(dev.name || dev.id)}')"
                            title="Renombrar" class="text-slate-500 hover:text-slate-300 p-1">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                        </button>
                    </div>
                </div>
                <div class="flex items-center justify-between mt-1 text-[11px] text-slate-400 pl-5">
                    <span>${statusText}</span>
                    <span>${timeAgo}</span>
                </div>
            </div>
        `;
    }).join('');
}

// Marcadores en el Mapa
function renderDeviceMarkers(devices) {
    currentMarkersGroup.clearLayers();

    devices.forEach(dev => {
        if (!dev.latest_point) return;

        const lat = dev.latest_point.latitude;
        const lng = dev.latest_point.longitude;
        const speedKmh = Math.round((dev.latest_point.speed || 0) * 3.6);

        // Icono animado personalizado
        const customIcon = L.divIcon({
            className: 'custom-pulse-marker',
            html: `<div class="pulse-dot" style="${dev.is_online ? '' : 'background: #64748b; box-shadow: none; animation: none;'}"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        const marker = L.marker([lat, lng], { icon: customIcon });

        const popupContent = `
            <div class="text-xs space-y-1">
                <div class="font-bold text-sky-400">${escapeHtml(dev.name || dev.id)}</div>
                <div><b>Velocidad:</b> ${speedKmh} km/h</div>
                <div><b>Precisión:</b> ±${Math.round(dev.latest_point.accuracy || 0)} m</div>
                <div><b>Última captura:</b> ${new Date(dev.latest_point.timestamp).toLocaleTimeString()}</div>
            </div>
        `;

        marker.bindPopup(popupContent);
        currentMarkersGroup.addLayer(marker);
    });
}

// Seleccionar un dispositivo
function selectDevice(deviceId) {
    selectedDeviceId = deviceId;
    renderDeviceList(devicesCache);

    const dev = devicesCache.find(d => d.id === deviceId);
    if (dev) {
        updateTelemetryBox(dev);
        loadRoute(deviceId, true);
    }
}

// Actualizar tarjeta de telemetría inferior
function updateTelemetryBox(dev) {
    const box = document.getElementById('telemetryBox');
    box.classList.remove('hidden');

    document.getElementById('selectedDevName').innerText = dev.name || dev.id;
    const badge = document.getElementById('selectedDevBadge');
    if (dev.is_online) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        badge.innerText = 'EN LÍNEA';
    } else {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700 text-slate-300';
        badge.innerText = 'DESCONECTADO';
    }

    if (dev.latest_point) {
        const speedKmh = Math.round((dev.latest_point.speed || 0) * 3.6);
        document.getElementById('statSpeed').innerText = `${speedKmh} km/h`;
        document.getElementById('statAccuracy').innerText = `±${Math.round(dev.latest_point.accuracy || 0)} m`;
        document.getElementById('statAltitude').innerText = `${Math.round(dev.latest_point.altitude || 0)} m`;
        document.getElementById('statLastSeen').innerText = new Date(dev.latest_point.timestamp).toLocaleString();
    } else {
        document.getElementById('statSpeed').innerText = '0 km/h';
        document.getElementById('statAccuracy').innerText = '±0 m';
        document.getElementById('statAltitude').innerText = '0 m';
        document.getElementById('statLastSeen').innerText = 'Sin puntos';
    }
}

// Cargar la ruta de un dispositivo
async function loadRoute(deviceId, fitBounds = true) {
    let queryUrl = `/api/v1/devices/${deviceId}/route`;
    if (currentFilterMode === 'date') {
        const filterDate = document.getElementById('filterDate').value;
        const startHour = document.getElementById('startHour').value;
        const endHour = document.getElementById('endHour').value;
        queryUrl += `?date=${encodeURIComponent(filterDate)}&start_hour=${startHour}&end_hour=${endHour}`;
    } else {
        const hours = document.getElementById('timeRange').value;
        queryUrl += `?hours=${hours}`;
    }

    try {
        const res = await fetch(queryUrl);
        const data = await res.json();
        const points = data.points || [];
        const stats = data.stats || {};

        if (currentPolyline) {
            map.removeLayer(currentPolyline);
            currentPolyline = null;
        }
        routeEndpointsGroup.clearLayers();

        // Actualizar tarjeta de métricas
        const totalDistElem = document.getElementById('routeTotalDist');
        const maxSpeedElem = document.getElementById('routeMaxSpeed');
        const pointsCountElem = document.getElementById('routePointsCount');
        if (totalDistElem) totalDistElem.innerText = `${stats.total_distance_km || 0.0} km`;
        if (maxSpeedElem) maxSpeedElem.innerText = `${stats.max_speed_kmh || 0} km/h`;
        if (pointsCountElem) pointsCountElem.innerText = `${stats.total_points || 0} puntos`;

        if (points.length === 0) return;

        const latLngs = points.map(p => [p.latitude, p.longitude]);

        // Dibujar polyline estilizada en color Cyan neón
        currentPolyline = L.polyline(latLngs, {
            color: '#38bdf8',
            weight: 5,
            opacity: 0.85,
            smoothFactor: 1
        }).addTo(map);

        // Marcador de Inicio (Verde) y Fin (Rojo/Bandera) si hay varios puntos
        if (points.length >= 2) {
            const firstPt = points[0];
            const startMarker = L.circleMarker([firstPt.latitude, firstPt.longitude], {
                radius: 7,
                fillColor: '#22c55e',
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            }).bindPopup(`<b>Punto de Inicio:</b> ${new Date(firstPt.timestamp).toLocaleTimeString()}`);
            routeEndpointsGroup.addLayer(startMarker);

            const lastPt = points[points.length - 1];
            const endMarker = L.circleMarker([lastPt.latitude, lastPt.longitude], {
                radius: 7,
                fillColor: '#ef4444',
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            }).bindPopup(`<b>Último Punto:</b> ${new Date(lastPt.timestamp).toLocaleTimeString()}<br>Velocidad: ${(lastPt.speed * 3.6).toFixed(1)} km/h`);
            routeEndpointsGroup.addLayer(endMarker);
        }

        if (fitBounds && latLngs.length > 0) {
            map.fitBounds(currentPolyline.getBounds(), { padding: [50, 50] });
        }
    } catch (e) {
        console.error("Error cargando ruta:", e);
    }
}

// Renombrar Dispositivo
async function renameDevice(deviceId, currentName) {
    const newName = prompt("Nuevo nombre para este dispositivo:", currentName);
    if (!newName || newName.trim() === "") return;

    try {
        const res = await fetch(`/api/v1/devices/${deviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
        });
        if (res.ok) {
            loadDevices();
        }
    } catch (e) {
        alert("Error al renombrar");
    }
}

// Formatear tiempo relativo
function formatTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'Hace un momento';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Hace ${hours} h`;
    return date.toLocaleDateString();
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Configurar temporizador de auto-refresco
function setupAutoRefresh() {
    const checkbox = document.getElementById('autoRefresh');
    
    function resetTimer() {
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        if (checkbox.checked) {
            autoRefreshTimer = setInterval(() => {
                loadDevices();
            }, 30000); // 30 segundos
        }
    }

    checkbox.addEventListener('change', resetTimer);
    resetTimer();
}

// Inicialización al cargar la ventana
window.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadDevices();
    setupAutoRefresh();

    // Inicializar selectores de horas (00:00 a 23:00)
    const startHourSelect = document.getElementById('startHour');
    const endHourSelect = document.getElementById('endHour');
    for (let h = 0; h < 24; h++) {
        const val = h.toString().padStart(2, '0') + ':00';
        startHourSelect.innerHTML += `<option value="${h}" ${h === 0 ? 'selected' : ''}>${val}</option>`;
        endHourSelect.innerHTML += `<option value="${h}" ${h === 23 ? 'selected' : ''}>${val}</option>`;
    }

    // Inicializar selector de fecha con la fecha de hoy
    const today = new Date().toISOString().split('T')[0];
    const filterDateInput = document.getElementById('filterDate');
    if (filterDateInput) filterDateInput.value = today;

    // Cambiar entre Modo Rápido y Modo por Fecha
    const btnQuick = document.getElementById('btnModeQuick');
    const btnDate = document.getElementById('btnModeDate');
    const panelQuick = document.getElementById('filterQuickPanel');
    const panelDate = document.getElementById('filterDatePanel');

    btnQuick.addEventListener('click', () => {
        currentFilterMode = 'quick';
        btnQuick.className = 'px-2 py-0.5 rounded-md font-medium bg-sky-600 text-white transition';
        btnDate.className = 'px-2 py-0.5 rounded-md font-medium text-slate-400 hover:text-white transition';
        panelQuick.classList.remove('hidden');
        panelDate.classList.add('hidden');
        if (selectedDeviceId) loadRoute(selectedDeviceId, true);
    });

    btnDate.addEventListener('click', () => {
        currentFilterMode = 'date';
        btnDate.className = 'px-2 py-0.5 rounded-md font-medium bg-sky-600 text-white transition';
        btnQuick.className = 'px-2 py-0.5 rounded-md font-medium text-slate-400 hover:text-white transition';
        panelQuick.classList.add('hidden');
        panelDate.classList.remove('hidden');
        if (selectedDeviceId) loadRoute(selectedDeviceId, true);
    });

    document.getElementById('btnApplyDateFilter').addEventListener('click', () => {
        if (selectedDeviceId) loadRoute(selectedDeviceId, true);
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
        loadDevices();
    });

    // Botón flotante: Centrar en el dispositivo activo
    document.getElementById('btnCenterActiveDev')?.addEventListener('click', () => {
        if (selectedDeviceId) {
            const dev = devicesCache.find(d => d.id === selectedDeviceId);
            if (dev && dev.last_latitude && dev.last_longitude) {
                map.flyTo([dev.last_latitude, dev.last_longitude], 16, { duration: 1.2 });
            }
        }
    });

    document.getElementById('timeRange').addEventListener('change', () => {
        if (selectedDeviceId) {
            loadRoute(selectedDeviceId, true);
        }
    });
});
