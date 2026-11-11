// Estado Global de la Aplicación
let map = null;
let currentPolyline = null;
let currentMarkersGroup = null;
let routeEndpointsGroup = null;
let selectedDeviceId = null;
let devicesCache = [];
let autoRefreshTimer = null;
let currentFilterMode = 'quick'; // 'quick' o 'date'
let showLabels = true; // Control de visibilidad de etiquetas permanentes

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
    const mobileTab = document.getElementById('mobileTabDevText');
    if (mobileTab) mobileTab.innerText = `Móviles (${devices.length})`;

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

// Distancia en metros entre dos coordenadas (Haversine)
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function formatShortTime(isoStr) {
    if (!isoStr) return '';
    return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Marcadores en el Mapa
function renderDeviceMarkers(devices) {
    currentMarkersGroup.clearLayers();

    devices.forEach(dev => {
        if (!dev.latest_point) return;

        const lat = dev.latest_point.latitude;
        const lng = dev.latest_point.longitude;
        const speedKmh = Math.round((dev.latest_point.speed || 0) * 3.6);
        const timeStr = formatShortTime(dev.latest_point.timestamp);

        // Icono animado personalizado
        const customIcon = L.divIcon({
            className: 'custom-pulse-marker',
            html: `<div class="pulse-dot" style="${dev.is_online ? '' : 'background: #64748b; box-shadow: none; animation: none;'}"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        const marker = L.marker([lat, lng], { icon: customIcon });

        const popupContent = `
            <div class="space-y-2">
                <!-- Encabezado con nombre y estado -->
                <div class="flex items-center justify-between pb-1.5 pr-7 border-b border-slate-700/80">
                    <span class="font-bold text-sm text-white truncate max-w-[125px]">${escapeHtml(dev.name || dev.id)}</span>
                    <span class="${dev.is_online ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-slate-800 text-slate-400 border border-slate-700'} px-2 py-0.5 rounded-full text-[9px] font-bold">
                        ${dev.is_online ? 'EN LÍNEA' : 'DESCONECTADO'}
                    </span>
                </div>

                <!-- Métricas -->
                <div class="grid grid-cols-2 gap-1.5 text-center">
                    <div class="bg-slate-900/90 border border-slate-800 rounded-lg p-1.5">
                        <span class="text-[9px] font-semibold text-slate-400 uppercase tracking-wider block">Velocidad</span>
                        <span class="text-sm font-extrabold text-sky-400 block">${speedKmh} km/h</span>
                    </div>
                    <div class="bg-slate-900/90 border border-slate-800 rounded-lg p-1.5">
                        <span class="text-[9px] font-semibold text-slate-400 uppercase tracking-wider block">Precisión</span>
                        <span class="text-sm font-extrabold text-emerald-400 block">±${Math.round(dev.latest_point.accuracy || 0)} m</span>
                    </div>
                </div>

                <!-- Info -->
                <div class="bg-slate-900/60 border border-slate-800/80 rounded-lg p-2 space-y-1 text-[11px] text-slate-300">
                    <div class="flex justify-between">
                        <span class="text-slate-400">Altitud:</span>
                        <span class="font-medium text-slate-200">${Math.round(dev.latest_point.altitude || 0)} m</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-slate-400">Última señal:</span>
                        <span class="font-medium text-slate-200">${new Date(dev.latest_point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <div class="flex justify-between pt-1 border-t border-slate-800/80 text-[10px]">
                        <span class="text-slate-400">Coords:</span>
                        <span class="font-mono text-sky-300">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>
                    </div>
                </div>

                <!-- Botones -->
                <div class="flex space-x-1.5 pt-0.5">
                    <button onclick="map.flyTo([${lat}, ${lng}], 17, { duration: 1 }); selectDevice('${dev.id}');" 
                        class="flex-1 py-1 px-2 text-xs font-semibold bg-sky-600 hover:bg-sky-500 active:scale-95 text-white rounded-lg transition flex items-center justify-center space-x-1 shadow">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
                        <span>Centrar</span>
                    </button>
                    <button onclick="renameDevice('${dev.id}', '${escapeHtml(dev.name || dev.id)}')" 
                        class="flex-1 py-1 px-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-200 rounded-lg border border-slate-700 transition flex items-center justify-center space-x-1">
                        <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                        <span>Renombrar</span>
                    </button>
                </div>
            </div>
        `;
        marker.bindPopup(popupContent, {
            maxWidth: 280,
            minWidth: 230,
            autoPan: true,
            autoPanPadding: [15, 15]
        });

        // Click en el marcador: seleccionar dispositivo y abrir detalle en sheet y popup
        marker.on('click', () => {
            selectDevice(dev.id);
            updateMobileSheet(dev);
        });

        // Etiqueta permanente identificadora del dispositivo con su nombre de configuración
        if (showLabels) {
            const statusDot = dev.is_online ? '🟢' : '⚪';
            const labelText = `${statusDot} ${escapeHtml(dev.name || dev.id)}`;
            marker.bindTooltip(labelText, {
                permanent: true,
                interactive: true,
                direction: 'top',
                offset: [0, -12],
                className: 'custom-map-tooltip'
            });

            // Al hacer clic en la etiqueta de texto flotante, se selecciona y se abre el popup y sheet
            marker.on('tooltipopen', (e) => {
                const tooltipEl = e.tooltip.getElement();
                if (tooltipEl) {
                    tooltipEl.onclick = (ev) => {
                        ev.stopPropagation();
                        selectDevice(dev.id);
                        updateMobileSheet(dev);
                        setTimeout(() => marker.openPopup(), 100);
                    };
                }
            });
            const existingEl = marker.getTooltip()?.getElement();
            if (existingEl) {
                existingEl.onclick = (ev) => {
                    ev.stopPropagation();
                    selectDevice(dev.id);
                    updateMobileSheet(dev);
                    setTimeout(() => marker.openPopup(), 100);
                };
            }
        }

        currentMarkersGroup.addLayer(marker);
    });
}

// Actualizar Ficha Mobile-First (Bottom Sheet)
function updateMobileSheet(dev) {
    const sheet = document.getElementById('mobileDetailSheet');
    if (!sheet) return;

    sheet.classList.remove('hidden');

    document.getElementById('sheetDevName').innerText = dev.name || dev.id;
    const badge = document.getElementById('sheetDevBadge');
    if (dev.is_online) {
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
        badge.innerText = '● EN LÍNEA';
    } else {
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
        badge.innerText = '○ DESCONECTADO';
    }

    if (dev.latest_point) {
        const speedKmh = Math.round((dev.latest_point.speed || 0) * 3.6);
        document.getElementById('sheetSpeed').innerText = `${speedKmh} km/h`;
        document.getElementById('sheetAccuracy').innerText = `±${Math.round(dev.latest_point.accuracy || 0)} m`;
        document.getElementById('sheetAltitude').innerText = `${Math.round(dev.latest_point.altitude || 0)} m`;
        document.getElementById('sheetLastSeen').innerText = 'Última señal: ' + new Date(dev.latest_point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        document.getElementById('sheetCoords').innerText = `${dev.latest_point.latitude.toFixed(5)}, ${dev.latest_point.longitude.toFixed(5)}`;

        document.getElementById('btnSheetCenter').onclick = () => {
            map.flyTo([dev.latest_point.latitude, dev.latest_point.longitude], 17, { duration: 1 });
        };
    } else {
        document.getElementById('sheetSpeed').innerText = '0 km/h';
        document.getElementById('sheetAccuracy').innerText = '±0 m';
        document.getElementById('sheetAltitude').innerText = '0 m';
        document.getElementById('sheetLastSeen').innerText = 'Sin registros GPS';
        document.getElementById('sheetCoords').innerText = '-';
    }

    document.getElementById('btnSheetRename').onclick = () => {
        renameDevice(dev.id, dev.name || dev.id);
    };
}

function closeMobileSheet() {
    const sheet = document.getElementById('mobileDetailSheet');
    if (sheet) sheet.classList.add('hidden');
}

// Seleccionar un dispositivo
function selectDevice(deviceId) {
    selectedDeviceId = deviceId;
    renderDeviceList(devicesCache);

    const dev = devicesCache.find(d => d.id === deviceId);
    if (dev) {
        updateTelemetryBox(dev);
        updateMobileSheet(dev);
        loadRoute(deviceId, true);

        // En vista móvil (< 768px), pasar automáticamente al mapa
        const btnTabMap = document.getElementById('btnMobileTabMap');
        if (btnTabMap && window.innerWidth < 768) {
            btnTabMap.click();
        }
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

        if (points.length === 1) {
            const pt = points[0];
            const ptTimeStr = formatShortTime(pt.timestamp);
            const singleMarker = L.circleMarker([pt.latitude, pt.longitude], {
                radius: 7,
                fillColor: '#38bdf8',
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            }).bindPopup(`<b>📍 Posición Única:</b> ${ptTimeStr}`);
            if (showLabels) {
                singleMarker.bindTooltip(`📍 ${ptTimeStr}`, {
                    permanent: true,
                    interactive: true,
                    direction: 'top',
                    offset: [0, -8],
                    className: 'custom-map-tooltip'
                });
            }
            routeEndpointsGroup.addLayer(singleMarker);
        } else if (points.length >= 2) {
            // 1. Punto de Inicio (Verde)
            const firstPt = points[0];
            const startTimeStr = formatShortTime(firstPt.timestamp);
            const startMarker = L.circleMarker([firstPt.latitude, firstPt.longitude], {
                radius: 8,
                fillColor: '#22c55e',
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.95
            });
            const startPopup = `
                <div class="p-3 w-[265px] space-y-2">
                    <div class="flex items-center justify-between pb-1.5 pr-8 border-b border-slate-700/80">
                        <div class="flex items-center space-x-1.5 font-bold text-sm text-emerald-400">
                            <span>🟢 Punto de Inicio</span>
                        </div>
                    </div>
                    <div class="bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5 space-y-1.5 text-xs text-slate-300">
                        <div class="flex justify-between">
                            <span class="text-slate-400">🕒 Hora de inicio:</span>
                            <span class="font-semibold text-white">${startTimeStr}</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-slate-400">⛰️ Altitud:</span>
                            <span class="font-semibold text-white">${Math.round(firstPt.altitude || 0)} m</span>
                        </div>
                        <div class="flex justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                            <span>Coords:</span>
                            <span class="font-mono text-sky-300">${firstPt.latitude.toFixed(5)}, ${firstPt.longitude.toFixed(5)}</span>
                        </div>
                    </div>
                </div>
            `;
            startMarker.bindPopup(startPopup);

            if (showLabels) {
                startMarker.bindTooltip('🟢 Inicio', {
                    permanent: true,
                    interactive: true,
                    direction: 'top',
                    offset: [0, -8],
                    className: 'route-start-tooltip'
                });
                startMarker.on('tooltipopen', (e) => {
                    const el = e.tooltip.getElement();
                    if (el) {
                        el.onclick = (ev) => {
                            ev.stopPropagation();
                            startMarker.openPopup();
                        };
                    }
                });
            }
            routeEndpointsGroup.addLayer(startMarker);

            // 2. Detección de Paradas / Detenciones intermedias (>= 4 min detenido en radio < 40m)
            // Agrupamos paradas cercanas para evitar etiquetas superpuestas
            const recordedStops = [];
            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                const t1 = new Date(p1.timestamp).getTime();
                const t2 = new Date(p2.timestamp).getTime();
                const diffMinutes = (t2 - t1) / 60000;
                const distMeters = haversineMeters(p1.latitude, p1.longitude, p2.latitude, p2.longitude);

                if (diffMinutes >= 4 && distMeters < 40) {
                    const isNearby = recordedStops.some(s => haversineMeters(p1.latitude, p1.longitude, s.lat, s.lng) < 45);
                    if (isNearby) continue;

                    recordedStops.push({ lat: p1.latitude, lng: p1.longitude, duration: diffMinutes });

                    const stopTimeStr = new Date(p1.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const stopMarker = L.circleMarker([p1.latitude, p1.longitude], {
                        radius: 6,
                        fillColor: '#f59e0b',
                        color: '#ffffff',
                        weight: 2,
                        opacity: 0.9,
                        fillOpacity: 0.95
                    });
                    const stopPopup = `
                        <div class="p-3 w-[275px] space-y-2">
                            <div class="flex items-center justify-between pb-1.5 pr-8 border-b border-slate-700/80">
                                <div class="flex items-center space-x-1.5 font-bold text-sm text-amber-400">
                                    <span>🅿️ Detención / Parada</span>
                                </div>
                                <span class="bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full text-[10px] font-bold">
                                    ${Math.round(diffMinutes)} MIN
                                </span>
                            </div>
                            <div class="bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5 space-y-1.5 text-xs text-slate-300">
                                <div class="flex justify-between">
                                    <span class="text-slate-400">🕒 Hora de parada:</span>
                                    <span class="font-semibold text-white">${stopTimeStr}</span>
                                </div>
                                <div class="flex justify-between">
                                    <span class="text-slate-400">⏳ Tiempo estacionado:</span>
                                    <span class="font-semibold text-amber-300">${Math.round(diffMinutes)} minutos</span>
                                </div>
                                <div class="flex justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                                    <span>Coords:</span>
                                    <span class="font-mono text-sky-300">${p1.latitude.toFixed(5)}, ${p1.longitude.toFixed(5)}</span>
                                </div>
                            </div>
                        </div>
                    `;
                    stopMarker.bindPopup(stopPopup);

                    if (showLabels) {
                        stopMarker.bindTooltip(`🅿️ Parada (${Math.round(diffMinutes)} min)`, {
                            permanent: true,
                            interactive: true,
                            direction: 'bottom',
                            offset: [0, 6],
                            className: 'route-stop-tooltip'
                        });
                        stopMarker.on('tooltipopen', (e) => {
                            const el = e.tooltip.getElement();
                            if (el) {
                                el.onclick = (ev) => {
                                    ev.stopPropagation();
                                    stopMarker.openPopup();
                                };
                            }
                        });
                    }
                    routeEndpointsGroup.addLayer(stopMarker);
                }
            }

            // 3. Puntos de Paso Intermedios Interactivos (Waypoints al pasar el cursor)
            const step = points.length > 80 ? Math.ceil(points.length / 40) : (points.length > 25 ? 2 : 1);
            for (let i = 1; i < points.length - 1; i += step) {
                const pt = points[i];
                const ptSpeed = Math.round((pt.speed || 0) * 3.6);
                const ptTime = formatShortTime(pt.timestamp);
                const wpMarker = L.circleMarker([pt.latitude, pt.longitude], {
                    radius: 3,
                    fillColor: '#38bdf8',
                    color: '#0f172a',
                    weight: 1,
                    opacity: 0.8,
                    fillOpacity: 0.85
                });
                wpMarker.bindTooltip(`🕒 ${ptTime} • ⚡ ${ptSpeed} km/h • 🎯 ±${Math.round(pt.accuracy || 0)}m`, {
                    direction: 'top',
                    offset: [0, -4],
                    className: 'waypoint-tooltip'
                });
                routeEndpointsGroup.addLayer(wpMarker);
            }

            // 4. Punto Final / Último Punto (Rojo)
            // No colocamos tooltip permanente encima para que no tape el nombre del dispositivo
            const lastPt = points[points.length - 1];
            const endTimeStr = formatShortTime(lastPt.timestamp);
            const lastSpeed = Math.round((lastPt.speed || 0) * 3.6);
            const endMarker = L.circleMarker([lastPt.latitude, lastPt.longitude], {
                radius: 8,
                fillColor: '#ef4444',
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.95
            });
            endMarker.bindPopup(`
                <div class="p-3 w-[265px] space-y-2">
                    <div class="flex items-center justify-between pb-1.5 pr-8 border-b border-slate-700/80">
                        <div class="flex items-center space-x-1.5 font-bold text-sm text-rose-400">
                            <span>🏁 Fin de Ruta</span>
                        </div>
                    </div>
                    <div class="bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5 space-y-1.5 text-xs text-slate-300">
                        <div class="flex justify-between">
                            <span class="text-slate-400">🕒 Hora final:</span>
                            <span class="font-semibold text-white">${endTimeStr}</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-slate-400">⚡ Velocidad final:</span>
                            <span class="font-semibold text-white">${lastSpeed} km/h</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-slate-400">🎯 Precisión:</span>
                            <span class="font-semibold text-white">±${Math.round(lastPt.accuracy || 0)} m</span>
                        </div>
                        <div class="flex justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                            <span>Coords:</span>
                            <span class="font-mono text-sky-300">${lastPt.latitude.toFixed(5)}, ${lastPt.longitude.toFixed(5)}</span>
                        </div>
                    </div>
                </div>
            `);
            endMarker.bindTooltip(`🏁 Fin de Ruta (${endTimeStr})`, {
                direction: 'bottom',
                offset: [0, 8],
                className: 'route-end-tooltip'
            });
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

// Configurar navegación de pestañas en Mobile (< md)
function setupMobileTabs() {
    const btnTabMap = document.getElementById('btnMobileTabMap');
    const btnTabList = document.getElementById('btnMobileTabList');
    const sidebar = document.getElementById('sidebarPanel');
    const mapArea = document.getElementById('mainMapArea');

    if (!btnTabMap || !btnTabList || !sidebar || !mapArea) return;

    btnTabMap.addEventListener('click', () => {
        btnTabMap.className = 'flex-1 py-3 text-center text-sky-400 border-b-2 border-sky-500 bg-slate-900/50 flex items-center justify-center space-x-1.5 transition';
        btnTabList.className = 'flex-1 py-3 text-center text-slate-400 border-b-2 border-transparent flex items-center justify-center space-x-1.5 transition hover:text-white';
        sidebar.classList.add('hidden');
        sidebar.classList.remove('flex');
        mapArea.classList.remove('hidden');
        mapArea.classList.add('flex');
        if (map) {
            setTimeout(() => map.invalidateSize(), 150);
        }
    });

    btnTabList.addEventListener('click', () => {
        btnTabList.className = 'flex-1 py-3 text-center text-sky-400 border-b-2 border-sky-500 bg-slate-900/50 flex items-center justify-center space-x-1.5 transition';
        btnTabMap.className = 'flex-1 py-3 text-center text-slate-400 border-b-2 border-transparent flex items-center justify-center space-x-1.5 transition hover:text-white';
        sidebar.classList.remove('hidden');
        sidebar.classList.add('flex');
        mapArea.classList.add('hidden');
        mapArea.classList.remove('flex');
    });
}

// Inicialización al cargar la ventana
window.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadDevices();
    setupAutoRefresh();
    setupMobileTabs();

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

    // Botón flotante: Conmutar visibilidad de etiquetas
    document.getElementById('btnToggleLabels')?.addEventListener('click', () => {
        showLabels = !showLabels;
        const btn = document.getElementById('btnToggleLabels');
        if (showLabels) {
            btn.classList.add('text-sky-400');
            btn.classList.remove('text-slate-500');
        } else {
            btn.classList.remove('text-sky-400');
            btn.classList.add('text-slate-500');
        }
        renderDeviceMarkers(devicesCache);
        if (selectedDeviceId) {
            loadRoute(selectedDeviceId, false);
        }
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
