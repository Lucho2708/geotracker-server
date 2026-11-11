from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel

class TelemetryPoint(BaseModel):
    id: Optional[int] = None
    timestamp: int
    latitude: float
    longitude: float
    altitude: Optional[float] = 0.0
    speed: Optional[float] = 0.0
    bearing: Optional[float] = 0.0
    accuracy: Optional[float] = 0.0

class TelemetryBatch(BaseModel):
    device_id: str
    sent_at: Optional[int] = None
    count: Optional[int] = None
    points: List[TelemetryPoint]

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

class DeviceUpdate(BaseModel):
    name: str

class LocationPointOut(BaseModel):
    id: int
    timestamp: int
    latitude: float
    longitude: float
    altitude: float
    speed: float
    bearing: float
    accuracy: float
    received_at: datetime

    class Config:
        from_attributes = True

class DeviceOut(BaseModel):
    id: str
    name: Optional[str]
    last_seen: datetime
    is_online: bool
    latest_point: Optional[LocationPointOut] = None

    class Config:
        from_attributes = True

class GeofenceCreate(BaseModel):
    name: str
    latitude: float
    longitude: float
    radius: float = 150.0
    color: Optional[str] = "#38bdf8"

class GeofenceOut(BaseModel):
    id: int
    name: str
    latitude: float
    longitude: float
    radius: float
    color: str
    created_at: datetime

    class Config:
        from_attributes = True
