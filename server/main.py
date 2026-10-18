import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path


from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from pydantic import BaseModel, EmailStr

DB_PATH = Path(__file__).parent / "notion.db"
SECRET_KEY = os.environ.get("NOTION_SECRET_KEY", "dev-secret-change-me").encode()
CODE_TTL_SECONDS = 10 * 60
MAX_ATTEMPTS = 5
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

class CodeRequest(BaseModel):
    email: EmailStr

class CodeVerify(BaseModel):
    email: EmailStr
    code: str

def hash_code(code: str) -> str:
    return hmac.new(SECRET_KEY, code.encode(), hashlib.sha256).hexdigest()

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

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
    db.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at INTEGER NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY,
            owner_id INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT 'Untitled',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    db.commit()
    db.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(lifespan=lifespan)

def current_user(session: str | None = Cookie(default=None)) -> dict:
    # for Depends(current_user), stops the request before an endpoint runs
    if session is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    db =get_db()
    try:
        user = db.execute(
            """
            SELECT users.id, users.email
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """,
            (hash_token(session), int(time.time())),
        ).fetchone()
    finally:
        db.close()
    if user is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    return dict(user)

@app.get("/api/health")
def health():
    return {"status": "ok"}

# Auth

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
def verify(body: CodeVerify, response: Response):
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
        # The token goes to the browser, only hash is stored
        token = secrets.token_urlsafe(32)
        db.execute(
            "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
            (user["id"], hash_token(token), now + SESSION_TTL_SECONDS),
        )
        # No secure flag, it is not production
        response.set_cookie(
            "session", token, max_age=SESSION_TTL_SECONDS, httponly=True, samesite="lax"
        )
        db.commit()
        return {"id": user["id"], "email": user["email"]}
    finally:
        db.close()

@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user

@app.post("/api/auth/logout")
def logout(response: Response, session: str | None = Cookie(default=None)):
    # logging out works even if there is no session or expired
    if session is not None:
        db = get_db()
        try:
            db.execute("DELETE FROM sessions WHERE token_hash = ?",
                    (hash_token(session),))
            db.commit()
            response.delete_cookie("session")
        finally:
            db.close()    
    return {"ok": True}

# Pages

@app.get("/api/pages")
def list_pages(user: dict = Depends(current_user)):
    db = get_db()
    try:
        rows = db.execute(
            "SELECT id, title, updated_at FROM pages WHERE owner_id = ? ORDER BY id",
            (user["id"],),
        ).fetchall()
    finally:
        db.close()
    return [dict(row) for row in rows]

# 201 - a resource did not exist before
@app.post("/api/pages", status_code=201)
def create_page(user: dict = Depends(current_user)):
    now = int(time.time())
    db = get_db()
    try:
        cursor = db.execute(
            "INSERT INTO pages (owner_id, created_at, updated_at) VALUES (?, ?, ?)",
            (user["id"], now, now),
        )
        db.commit()
    finally:
        db.close()
    # lastrowid: the id SQLite just assigned to the inserted row
    return {"id": cursor.lastrowid, "title": "Untitled", "updated_at": now}

@app.get("/api/pages/{page_id}")
def get_page(page_id: int, user: dict = Depends(current_user)):
    db = get_db()
    try:
        row = db.execute(
            "SELECT id, title, created_at, updated_at FROM pages WHERE id = ? AND owner_id = ?",
            (page_id, user["id"]),
        ).fetchone()
    finally:
        db.close()
    # If owned by someone else, gets the same 404
    if row is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return dict(row)