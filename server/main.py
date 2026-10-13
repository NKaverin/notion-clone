import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path


from fastapi import FastAPI
from pydantic import BaseModel, EmailStr

DB_PATH = Path(__file__).parent / "notion.db"
SECTRET_KEY = os.environ.get("NOTION_SECRET_KEY", "dev-secret-change-me").encode()
CODE_TTL_SECONDS = 10 * 60


class CodeRequest(BaseModel):
    email: EmailStr

def hash_code(code: str) -> str:
    return hmac.new(SECTRET_KEY, code.encode(), hashlib.sha256).hexdigest()

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db

def init_db():
    db = get_db()
    db.execute("""
        CREATE TABLE IF NOT EXISTS login_codes (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL,
            core_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        )
    """)
    db.commit()
    db.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(lifespan=lifespan)

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.post("/api/auth/request-code")
def request_code(body: CodeRequest):
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = int(time.time()) + CODE_TTL_SECONDS
    db = get_db()
    db.executemany(
        "INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ? , ?)",
        (body.email, hash_code(code), expires_at),
    )
    db.commit()
    db.close()
    print("LOGIN CODE", body.email, code)
    return {"sent": True}

