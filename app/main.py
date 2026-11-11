import os
import io
import csv
import math
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Request, Response, status, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import desc, text

from app.config import API_AUTH_TOKEN
from app.database import engine, get_db, Base
from app.models import Device, LocationPoint, User, Geofence
from app.schemas import (
    TelemetryBatch,
    LoginRequest,
    TokenResponse,
    DeviceOut,
    DeviceUpdate,
    LocationPointOut,
    GeofenceCreate,
    GeofenceOut
)
from app.auth import (
    verify_password,
    create_access_token,
    get_current_user,
    ensure_admin_user,
    decode_token
)

# Inicializar tablas
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="GeoTracker Server & Web Portal",
    description="Backend de ingestión de telemetría y portal web interactivo",
    version="1.1.0"
)

# ====================================================================
# GESTOR DE CONEXIONES WEBSOCKET (TIEMPO REAL PURO)
# ====================================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)

ws_manager = ConnectionManager()

# Montar archivos estáticos y plantillas
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

@app.on_event("startup")
def on_startup():
    db = next(get_db())
    ensure_admin_user(db)

# ====================================================================
# WEBSOCKET ENDPOINT PARA TRANSMISIÓN EN VIVO
# ====================================================================
@app.websocket("/ws/live")
async def websocket_live_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            # Escucha pings o mensajes del cliente para mantener el socket activo
            await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        ws_manager.disconnect(websocket)

# ====================================================================
# DESCARGA PÚBLICA DEL APK PARA DISPOSITIVOS MÓVILES
# ====================================================================
@app.get("/descargar")
@app.get("/download")
@app.get("/api/v1/download/app")
def download_apk():
    apk_path = os.path.join("app", "static", "downloads", "mapas.apk")
    if os.path.exists(apk_path):
        return FileResponse(
            path=apk_path,
            filename="Mapas.apk",
            media_type="application/vnd.android.package-archive"
        )
    raise HTTPException(status_code=404, detail="El archivo APK aún no ha sido cargado en el servidor.")

# ====================================================================
# INGESTIÓN DE TELEMETRÍA (Llamado por el APK Android cada 5 min)
# ====================================================================
@app.head("/api/v1/telemetry")
@app.get("/api/v1/telemetry")
def test_endpoint():
    return {"status": "online", "message": "GeoTracker Telemetry API lista"}

@app.post("/api/v1/telemetry", status_code=status.HTTP_201_CREATED)
async def ingest_telemetry(
    batch: TelemetryBatch,
    request: Request,
    db: Session = Depends(get_db)
):
    # Validación opcional de token si está configurado en el servidor
    if API_AUTH_TOKEN:
        auth_header = request.headers.get("Authorization", "")
        expected = f"Bearer {API_AUTH_TOKEN}"
        if auth_header != expected:
            raise HTTPException(status_code=403, detail="Token de autorización inválido")

    # Upsert del dispositivo
    device = db.query(Device).filter(Device.id == batch.device_id).first()
    if not device:
        device = Device(id=batch.device_id, name=f"Móvil {batch.device_id[:8]}")
        db.add(device)
    
    device.last_seen = datetime.utcnow()
    db.commit() # Asegurar que el dispositivo exista antes de insertar puntos (Foreign Key)

    # Inserción de lote de coordenadas
    points_to_insert = []
    for p in batch.points:
        point = LocationPoint(
            device_id=batch.device_id,
            timestamp=p.timestamp,
            latitude=p.latitude,
            longitude=p.longitude,
            altitude=p.altitude or 0.0,
            speed=p.speed or 0.0,
            bearing=p.bearing or 0.0,
            accuracy=p.accuracy or 0.0,
            received_at=datetime.utcnow()
        )
        points_to_insert.append(point)

    if points_to_insert:
        db.bulk_save_objects(points_to_insert)
        db.commit()

        # Transmisión inmediata vía WebSocket al mapa en vivo
        latest_p = points_to_insert[-1]
        await ws_manager.broadcast({
            "type": "new_location",
            "device_id": batch.device_id,
            "device_name": device.name,
            "is_online": True,
            "latest_point": {
                "latitude": latest_p.latitude,
                "longitude": latest_p.longitude,
                "altitude": latest_p.altitude,
                "speed": latest_p.speed,
                "bearing": latest_p.bearing,
                "accuracy": latest_p.accuracy,
                "timestamp": latest_p.timestamp
            }
        })
    else:
        # Latido periódico (Heartbeat sin desplazamiento)
        await ws_manager.broadcast({
            "type": "heartbeat",
            "device_id": batch.device_id,
            "device_name": device.name,
            "is_online": True,
            "last_seen": device.last_seen.isoformat()
        })

    return {
        "status": "success",
        "device_id": batch.device_id,
        "inserted_points": len(points_to_insert)
    }

# ====================================================================
# RUTAS WEB (HTML + JINJA)
# ====================================================================
@app.get("/", response_class=HTMLResponse)
def root_dashboard(request: Request, db: Session = Depends(get_db)):
    # Validar si el usuario tiene sesión activa
    token = request.cookies.get("access_token")
    if not token or not decode_token(token):
        return RedirectResponse(url="/login")

    return templates.TemplateResponse("dashboard.html", {"request": request})

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    token = request.cookies.get("access_token")
    if token and decode_token(token):
        return RedirectResponse(url="/")
    return templates.TemplateResponse("login.html", {"request": request})

@app.get("/logout")
def logout():
    response = RedirectResponse(url="/login")
    response.delete_cookie("access_token")
    return response

# ====================================================================
# API DE AUTENTICACIÓN
# ====================================================================
@app.post("/api/v1/auth/login")
def api_login(
    payload: LoginRequest,
    response: Response,
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == payload.username.strip()).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Usuario o contraseña incorrectos")

    token = create_access_token({"sub": user.username})
    
    # Seteamos cookie HttpOnly para el portal web
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        max_age=60 * 60 * 24 * 7,
        samesite="lax"
    )

    return {"access_token": token, "token_type": "bearer"}

# ====================================================================
# API DEL DASHBOARD (PROTEGIDA)
# ====================================================================
@app.get("/api/v1/devices", response_model=List[DeviceOut])
def get_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    devices = db.query(Device).all()
    results = []
    
    # Consideramos "online" si transmitió en los últimos 12 minutos (considerando ciclos de 5 min)
    online_threshold = datetime.utcnow() - timedelta(minutes=12)

    for d in devices:
        latest = (
            db.query(LocationPoint)
            .filter(LocationPoint.device_id == d.id)
            .order_by(desc(LocationPoint.timestamp))
            .first()
        )
        is_online = d.last_seen >= online_threshold
        
        results.append(
            DeviceOut(
                id=d.id,
                name=d.name or d.id,
                last_seen=d.last_seen,
                is_online=is_online,
                latest_point=LocationPointOut.from_orm(latest) if latest else None
            )
        )

    return results

@app.put("/api/v1/devices/{device_id}")
def update_device(
    device_id: str,
    payload: DeviceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    device.name = payload.name.strip()
    db.commit()
    return {"status": "ok", "name": device.name}

import math

def calculate_haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0 # Radio de la Tierra en km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

@app.delete("/api/v1/devices/{device_id}")
def delete_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    db.delete(device)
    db.commit()
    return {"status": "deleted"}

def ramer_douglas_peucker(points: list, epsilon: float = 0.00006) -> list:
    """Algoritmo RDP para simplificar polilíneas GPS manteniendo curvas y giros significativos."""
    if len(points) < 3:
        return points

    def perp_distance(pt, start, end):
        dx = end["longitude"] - start["longitude"]
        dy = end["latitude"] - start["latitude"]
        if dx == 0 and dy == 0:
            return math.hypot(pt["latitude"] - start["latitude"], pt["longitude"] - start["longitude"])
        return abs(dy * pt["longitude"] - dx * pt["latitude"] + end["latitude"] * start["longitude"] - end["longitude"] * start["latitude"]) / math.hypot(dx, dy)

    first = points[0]
    last = points[-1]
    dmax = 0.0
    index = 0

    for i in range(1, len(points) - 1):
        d = perp_distance(points[i], first, last)
        if d > dmax:
            index = i
            dmax = d

    if dmax > epsilon:
        rec1 = ramer_douglas_peucker(points[:index + 1], epsilon)
        rec2 = ramer_douglas_peucker(points[index:], epsilon)
        return rec1[:-1] + rec2
    else:
        return [points[0], points[-1]]

@app.get("/api/v1/devices/{device_id}/route")
def get_device_route(
    device_id: str,
    date: Optional[str] = Query(None), # Formato YYYY-MM-DD
    start_hour: Optional[int] = Query(None, ge=0, le=23),
    end_hour: Optional[int] = Query(None, ge=0, le=23),
    hours: Optional[int] = Query(None, ge=1, le=168), # Por defecto últimas N horas si no hay fecha
    simplify: bool = Query(True), # Compresión inteligente con RDP
    limit: int = Query(5000, le=10000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    query = db.query(LocationPoint).filter(LocationPoint.device_id == device_id)

    if date:
        try:
            target_date = datetime.strptime(date.strip(), "%Y-%m-%d")
            s_hour = start_hour if start_hour is not None else 0
            e_hour = end_hour if end_hour is not None else 23

            start_dt = target_date.replace(hour=s_hour, minute=0, second=0, microsecond=0)
            end_dt = target_date.replace(hour=e_hour, minute=59, second=59, microsecond=999999)

            start_ts = int(start_dt.timestamp() * 1000)
            end_ts = int(end_dt.timestamp() * 1000)

            query = query.filter(LocationPoint.timestamp >= start_ts, LocationPoint.timestamp <= end_ts)
        except Exception:
            raise HTTPException(status_code=400, detail="Formato de fecha inválido. Use YYYY-MM-DD")
    else:
        h = hours or 24
        since_timestamp = int((datetime.utcnow() - timedelta(hours=h)).timestamp() * 1000)
        query = query.filter(LocationPoint.timestamp >= since_timestamp)

    points = query.order_by(LocationPoint.timestamp.asc()).limit(limit).all()

    # Cálculo exacto de estadísticas con el 100% de los puntos
    total_km = 0.0
    max_speed_kmh = 0.0
    for i in range(len(points)):
        speed_kmh = (points[i].speed or 0.0) * 3.6
        if speed_kmh > max_speed_kmh:
            max_speed_kmh = speed_kmh
        if i > 0:
            dist = calculate_haversine_distance(
                points[i-1].latitude, points[i-1].longitude,
                points[i].latitude, points[i].longitude
            )
            # Descartar saltos GPS aberrantes mayores a 5km
            if dist < 5.0:
                total_km += dist

    raw_points_data = [
        {
            "id": p.id,
            "timestamp": p.timestamp,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "altitude": p.altitude,
            "speed": p.speed,
            "bearing": p.bearing,
            "accuracy": p.accuracy,
            "received_at": p.received_at.isoformat()
        }
        for p in points
    ]

    # Compresión RDP para transferencia y renderizado ultrarrápido
    if simplify and len(raw_points_data) > 150:
        rendered_points = ramer_douglas_peucker(raw_points_data, epsilon=0.00005)
    else:
        rendered_points = raw_points_data

    return {
        "stats": {
            "total_points": len(points),
            "rendered_points": len(rendered_points),
            "total_distance_km": round(total_km, 2),
            "max_speed_kmh": round(max_speed_kmh, 1),
            "first_timestamp": points[0].timestamp if points else None,
            "last_timestamp": points[-1].timestamp if points else None
        },
        "points": rendered_points,
        "all_points": raw_points_data # Para reproductor y playback detallado
    }

# ====================================================================
# EXPORTACIÓN DE RUTAS (CSV / EXCEL Y GPX PARA GOOGLE EARTH)
# ====================================================================
@app.get("/api/v1/devices/{device_id}/export/csv")
def export_route_csv(
    device_id: str,
    date: Optional[str] = Query(None),
    start_hour: Optional[int] = Query(None, ge=0, le=23),
    end_hour: Optional[int] = Query(None, ge=0, le=23),
    hours: Optional[int] = Query(None, ge=1, le=168),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    query = db.query(LocationPoint).filter(LocationPoint.device_id == device_id)
    if date:
        target_date = datetime.strptime(date.strip(), "%Y-%m-%d")
        s_hour = start_hour if start_hour is not None else 0
        e_hour = end_hour if end_hour is not None else 23
        start_ts = int(target_date.replace(hour=s_hour, minute=0, second=0).timestamp() * 1000)
        end_ts = int(target_date.replace(hour=e_hour, minute=59, second=59).timestamp() * 1000)
        query = query.filter(LocationPoint.timestamp >= start_ts, LocationPoint.timestamp <= end_ts)
    else:
        h = hours or 24
        since_timestamp = int((datetime.utcnow() - timedelta(hours=h)).timestamp() * 1000)
        query = query.filter(LocationPoint.timestamp >= since_timestamp)

    points = query.order_by(LocationPoint.timestamp.asc()).all()

    output = io.StringIO()
    output.write("\ufeff") # BOM para soporte nativo en Excel español
    writer = csv.writer(output)
    writer.writerow(["Móvil", "Fecha y Hora (UTC)", "Latitud", "Longitud", "Altitud (m)", "Velocidad (km/h)", "Rumbo (°)", "Precisión (m)"])

    for p in points:
        dt_str = datetime.utcfromtimestamp(p.timestamp / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
        speed_kmh = round((p.speed or 0.0) * 3.6, 1)
        writer.writerow([
            device.name or device.id,
            dt_str,
            f"{p.latitude:.6f}",
            f"{p.longitude:.6f}",
            round(p.altitude or 0.0, 1),
            speed_kmh,
            round(p.bearing or 0.0, 1),
            round(p.accuracy or 0.0, 1)
        ])

    clean_name = (device.name or device_id).replace(" ", "_")
    filename = f"recorrido_{clean_name}_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

@app.get("/api/v1/devices/{device_id}/export/gpx")
def export_route_gpx(
    device_id: str,
    date: Optional[str] = Query(None),
    start_hour: Optional[int] = Query(None, ge=0, le=23),
    end_hour: Optional[int] = Query(None, ge=0, le=23),
    hours: Optional[int] = Query(None, ge=1, le=168),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    query = db.query(LocationPoint).filter(LocationPoint.device_id == device_id)
    if date:
        target_date = datetime.strptime(date.strip(), "%Y-%m-%d")
        s_hour = start_hour if start_hour is not None else 0
        e_hour = end_hour if end_hour is not None else 23
        start_ts = int(target_date.replace(hour=s_hour, minute=0, second=0).timestamp() * 1000)
        end_ts = int(target_date.replace(hour=e_hour, minute=59, second=59).timestamp() * 1000)
        query = query.filter(LocationPoint.timestamp >= start_ts, LocationPoint.timestamp <= end_ts)
    else:
        h = hours or 24
        since_timestamp = int((datetime.utcnow() - timedelta(hours=h)).timestamp() * 1000)
        query = query.filter(LocationPoint.timestamp >= since_timestamp)

    points = query.order_by(LocationPoint.timestamp.asc()).all()

    clean_name = (device.name or device.id).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    gpx_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="GeoTracker Server" xmlns="http://www.topografix.com/GPX/1/1">',
        '  <trk>',
        f'    <name>{clean_name}</name>',
        '    <trkseg>'
    ]

    for p in points:
        iso_time = datetime.utcfromtimestamp(p.timestamp / 1000.0).strftime("%Y-%m-%dT%H:%M:%SZ")
        gpx_lines.append(f'      <trkpt lat="{p.latitude:.6f}" lon="{p.longitude:.6f}">')
        gpx_lines.append(f'        <ele>{p.altitude or 0.0:.1f}</ele>')
        gpx_lines.append(f'        <time>{iso_time}</time>')
        gpx_lines.append(f'        <speed>{p.speed or 0.0:.2f}</speed>')
        gpx_lines.append('      </trkpt>')

    gpx_lines.append('    </trkseg>')
    gpx_lines.append('  </trk>')
    gpx_lines.append('</gpx>')

    filename = f"ruta_{clean_name}_{datetime.utcnow().strftime('%Y%m%d')}.gpx"
    return Response(
        content="\n".join(gpx_lines),
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

# ====================================================================
# GEOCERCAS / ZONAS SEGURAS (GEOFENCING)
# ====================================================================
@app.get("/api/v1/geofences", response_model=List[GeofenceOut])
def list_geofences(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(Geofence).order_by(Geofence.created_at.desc()).all()

@app.post("/api/v1/geofences", response_model=GeofenceOut)
def create_geofence(payload: GeofenceCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    geofence = Geofence(
        name=payload.name.strip(),
        latitude=payload.latitude,
        longitude=payload.longitude,
        radius=payload.radius,
        color=payload.color or "#38bdf8"
    )
    db.add(geofence)
    db.commit()
    db.refresh(geofence)
    return geofence

@app.delete("/api/v1/geofences/{geofence_id}")
def delete_geofence(geofence_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    gf = db.query(Geofence).filter(Geofence.id == geofence_id).first()
    if not gf:
        raise HTTPException(status_code=404, detail="Geocerca no encontrada")
    db.delete(gf)
    db.commit()
    return {"status": "ok"}

# ====================================================================
# MANTENIMIENTO Y PURGA DE DATOS ANTIGUOS
# ====================================================================
@app.post("/api/v1/maintenance/cleanup")
def cleanup_old_records(
    days: int = Query(60, ge=7, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    threshold_dt = datetime.utcnow() - timedelta(days=days)
    threshold_ts = int(threshold_dt.timestamp() * 1000)

    deleted_count = db.query(LocationPoint).filter(LocationPoint.timestamp < threshold_ts).delete()
    db.commit()

    return {
        "status": "success",
        "purged_records": deleted_count,
        "kept_days": days
    }
