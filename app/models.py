from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, BigInteger, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from app.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class Device(Base):
    __tablename__ = "devices"

    id = Column(String(100), primary_key=True, index=True) # device_id enviado por el APK
    name = Column(String(150), nullable=True)             # Nombre amigable ("Mi Celular")
    last_seen = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    locations = relationship("LocationPoint", back_populates="device", cascade="all, delete-orphan")

class LocationPoint(Base):
    __tablename__ = "location_points"

    id = Column(Integer, primary_key=True, autoincrement=True)
    device_id = Column(String(100), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    timestamp = Column(BigInteger, nullable=False) # Timestamp en ms UTC enviado por el GPS
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    altitude = Column(Float, default=0.0)
    speed = Column(Float, default=0.0)             # m/s
    bearing = Column(Float, default=0.0)           # grados
    accuracy = Column(Float, default=0.0)          # metros
    received_at = Column(DateTime, default=datetime.utcnow)

    device = relationship("Device", back_populates="locations")

    __table_args__ = (
        Index("idx_device_timestamp", "device_id", "timestamp"),
    )
