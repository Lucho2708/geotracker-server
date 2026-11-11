import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Si estamos dentro de Docker o la carpeta /app/data existe, la usamos; si no, relativa local
LOCAL_DATA_DIR = BASE_DIR / "data"
LOCAL_DATA_DIR.mkdir(exist_ok=True)

DEFAULT_SQLITE = f"sqlite:///{LOCAL_DATA_DIR}/geotracker.db"

DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_SQLITE)
# Corrección para postgres/mysql si es necesario
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

SECRET_KEY = os.getenv("SECRET_KEY", "geotracker_super_secret_jwt_token_key_change_in_prod")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 días de sesión

ADMIN_USER = os.getenv("ADMIN_USER", "nexo_master")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Nx#Track2026!Pro$")
API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "")
