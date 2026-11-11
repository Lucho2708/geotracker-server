from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Request, Response, status, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.config import API_AUTH_TOKEN
from app.database import engine, get_db, Base
from app.models import Device, LocationPoint, User
from app.schemas import TelemetryBatch, LoginRequest, TokenResponse, DeviceOut, DeviceUpdate, LocationPointOut
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
    version="1.0.0"
)

# Montar archivos estáticos y plantillas
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

@app.on_event("startup")
def on_startup():
    db = next(get_db())
    ensure_admin_user(db)

# ====================================================================
# INGESTIÓN DE TELEMETRÍA (Llamado por el APK Android cada 5 min)
# ====================================================================
@app.head("/api/v1/telemetry")
@app.get("/api/v1/telemetry")
def test_endpoint():
    return {"status": "online", "message": "GeoTracker Telemetry API lista"}

@app.post("/api/v1/telemetry", status_code=status.HTTP_201_CREATED)
def ingest_telemetry(
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

@app.get("/api/v1/devices/{device_id}/route")
def get_device_route(
    device_id: str,
    hours: int = Query(24, ge=1, le=168), # Por defecto últimas 24 horas
    limit: int = Query(2000, le=5000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    since_timestamp = int((datetime.utcnow() - timedelta(hours=hours)).timestamp() * 1000)

    points = (
        db.query(LocationPoint)
        .filter(LocationPoint.device_id == device_id)
        .filter(LocationPoint.timestamp >= since_timestamp)
        .order_by(LocationPoint.timestamp.asc())
        .limit(limit)
        .all()
    )

    return [
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
