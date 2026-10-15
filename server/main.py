import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path


from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, EmailStr

DB_PATH = Path(__file__).parent / "notion.db"
SECRET_KEY = os.environ.get("NOTION_SECRET_KEY", "dev-secret-change-me").encode()
CODE_TTL_SECONDS = 10 * 60
MAX_ATTEMPTS = 5


class CodeRequest(BaseModel):
    email: EmailStr

class CodeVerify(BaseModel):
    email: EmailStr
    code: str

def hash_code(code: str) -> str:
    return hmac.new(SECRET_KEY, code.encode(), hashlib.sha256).hexdigest()

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
            code_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER NOT NULL PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
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
    email = body.email.lower()
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = int(time.time()) + CODE_TTL_SECONDS
    db = get_db()
    db.execute("UPDATE login_codes SET used = 1 WHERE email = ?", (email,))
    db.execute(
        "INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ? , ?)",
        (email, hash_code(code), expires_at),
    )
    db.commit()
    db.close()
    print("LOGIN CODE", email, code)
    return {"sent": True}

@app.post("/api/auth/verify")
def verify(body: CodeVerify):
    email = body.email.lower()
    now = int(time.time())
    db = get_db()
    try:
        row = db.execute(
            """
            SELECT *
            FROM login_codes
            WHERE email = ? AND expires_at > ? AND used = 0 and attempts < ?
            ORDER BY id DESC LIMIT 1
            """,
            (email, now, MAX_ATTEMPTS),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=400, detail="Invalid or expired code")
        if not hmac.compare_digest(row["code_hash"], hash_code(body.code)):
            db.execute("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?", (row["id"],))
            # Commit before raising, or the count is lost.
            db.commit()
            raise HTTPException(status_code=400, detail="Invalid or expired code")
        db.execute("UPDATE login_codes SET used = 1 WHERE email = ?", (email,))
        user = db.execute("SELECT id, email FROM users WHERE email = ?", (email,)).fetchone()
        if user is None:
            db.execute("INSERT INTO users (email, created_at) VALUES (?, ?)", (email, now))
            user = db.execute("SELECT id, email FROM users WHERE email = ?", (email,)).fetchone()
        db.commit()
        return {"id": user["id"], "email": user["email"]}
    finally:
        db.close()

