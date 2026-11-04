import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from typing import Literal
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

# Mirror Span and Block in the web app
class SpanModel(BaseModel):
    text: str
    bold: bool
    italic: bool
    math: str | None = None

class BlockModel(BaseModel):
    id: str
    type: Literal["paragraph", "h1", "h2", "h3", "bullet", "equation"]
    spans: list[SpanModel]

class PageUpdate(BaseModel):
    title: str
    blocks: list[BlockModel]

class PageMove(BaseModel):
    parent_id: int | None
    index: int

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

# Migrations
def add_content_column(db: sqlite3.Connection):
    columns = [row["name"] for row in db.execute("PRAGMA table_info(pages)")]
    if "content" not in columns:
        db.execute("ALTER TABLE pages ADD COLUMN content TEXT NOT NULL DEFAULT '[]'")

def add_parent_column(db:sqlite3.Connection):
    # NULL is a top-level page
    db.execute("ALTER TABLE pages ADD COLUMN parent_id INTEGER")

def add_position_column(db: sqlite3.Connection):
    db.execute("ALTER TABLE pages ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
    db.execute("UPDATE pages SET position = id")

MIGRATIONS = [add_content_column, add_parent_column, add_position_column]

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
    # No pages = fresh db
    fresh = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pages'").fetchone() is None
    db.execute("""
        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY,
            owner_id INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT 'Untitled',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            content TEXT NOT NULL DEFAULT '[]',
            parent_id INTEGER,
            position INTEGER NOT NULL DEFAULT 0
        )
    """)
    if fresh:
        db.execute(f"PRAGMA user_version = {len(MIGRATIONS)}")
    # Migrations
    version = db.execute("PRAGMA user_version").fetchone()[0]
    for number, migrate in enumerate(MIGRATIONS[version:], start= version + 1):
        migrate(db)
        db.execute(f"PRAGMA user_version = {number}")
    db.execute("CREATE INDEX IF NOT EXISTS pages_siblings ON pages (owner_id, parent_id, position)")
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
            "SELECT id, title, parent_id, position, updated_at FROM pages WHERE owner_id = ? ORDER BY position",
            (user["id"],),
        ).fetchall()
    finally:
        db.close()
    return [dict(row) for row in rows]

# A position after all of the user's pages
def next_position(db: sqlite3.Connection, user: dict) -> int:
    row = db.execute("SELECT MAX(position) FROM pages WHERE owner_id = ?", (user["id"],)).fetchone()
    return (row[0] or 0) + 1

# 201 - a resource did not exist before
@app.post("/api/pages", status_code=201)
def create_page(user: dict = Depends(current_user)):
    now = int(time.time())
    db = get_db()
    try:
        cursor = db.execute(
            "INSERT INTO pages (owner_id, position, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (user["id"], next_position(db, user), now, now),
        )
        db.commit()
    finally:
        db.close()
    # lastrowid: the id SQLite just assigned to the inserted row
    return {"id": cursor.lastrowid, "title": "Untitled", "updated_at": now}

def get_owned_page(db: sqlite3.Connection, page_id: int, user: dict) -> sqlite3.Row:
    row = db.execute(
        "SELECT id, parent_id, title, content, created_at, updated_at FROM pages WHERE id = ? AND owner_id = ?",
        (page_id, user["id"]),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return row

# Copy of X (n) if that title is already taken
def copy_title(title: str, taken: set[str]) -> str:
    base = "Copy of " + title
    if base not in taken:
        return base
    n = 1
    while f"{base} ({n})" in taken:
        n += 1
    return f"{base} ({n})"

@app.get("/api/pages/{page_id}")
def get_page(page_id: int, user: dict = Depends(current_user)):
    db = get_db()
    try:
        row = get_owned_page(db, page_id, user)
    finally:
        db.close()
    page = dict(row)
    page["blocks"] = json.loads(page.pop("content"))
    return page

@app.put("/api/pages/{page_id}")
def update_page(page_id: int, body: PageUpdate, user: dict = Depends(current_user)):
    # math: null !== undefined 
    content = json.dumps(body.model_dump(exclude_none=True)["blocks"])
    now = int(time.time())
    db = get_db()
    try:
        cursor = db.execute(
            "UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
            (body.title, content, now, page_id, user["id"]),
        )
        db.commit()
    finally:
        db.close()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Page not found")
    return {"updated_at": now}

@app.post("/api/pages/{page_id}/duplicate", status_code=201)
def duplicate_page(page_id: int, user: dict = Depends(current_user)):
    now = int(time.time())
    db = get_db()
    try:
        original = get_owned_page(db, page_id, user)
        taken = {row["title"] for row in db.execute("SELECT title FROM pages WHERE owner_id = ?", (user["id"],))}
        title = copy_title(original["title"], taken)
        cursor = db.execute(
            "INSERT INTO pages (owner_id, parent_id, position, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user["id"], original["parent_id"], next_position(db, user), title, original["content"], now, now),
        )
        db.commit()
    finally:
        db.close()
    return {"id": cursor.lastrowid, "title": title, "parent_id": original["parent_id"], "updated_at": now}

@app.post("/api/pages/{page_id}/children", status_code=201)
def create_child_page(page_id: int, user: dict = Depends(current_user)):
    now = int(time.time())
    db = get_db()
    try: 
        get_owned_page(db, page_id, user)
        cursor = db.execute(
            "INSERT INTO pages (owner_id, parent_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (user["id"], page_id, next_position(db, user), now, now),
        )
        db.commit()
    finally:
        db.close()
    return {"id": cursor.lastrowid, "title": "Untitled", "parent_id": page_id, "updated_at": now}

@app.post("/api/pages/{page_id}/move")
def move_page(page_id: int, body: PageMove, user: dict = Depends(current_user)):
    db = get_db()
    try:
        get_owned_page(db, page_id, user)
        if body.parent_id is not None:
            get_owned_page(db, body.parent_id, user)
            # Walk from new parent
            ancestor = body.parent_id
            while ancestor is not None:
                if ancestor == page_id:
                    raise HTTPException(status_code=400, detail="Can't move a page inside itself")
                row = db.execute("SELECT parent_id FROM pages WHERE id = ?", (ancestor,)).fetchone()
                ancestor = row["parent_id"]
        # Bottleneck to change
        siblings = [
            row["id"]
            for row in db.execute(
                "SELECT id FROM pages WHERE owner_id = ? AND parent_id IS ? AND id != ? ORDER BY position",
                (user["id"], body.parent_id, page_id),
            )
        ]
        index = max(0, min(body.index, len(siblings)))
        siblings.insert(index, page_id)
        db.execute("UPDATE pages SET parent_id = ? WHERE id = ?", (body.parent_id, page_id))
        for position, sibling_id in enumerate(siblings):
            db.execute("UPDATE pages SET position = ? WHERE id = ?", (position, sibling_id))
        db.commit()
    finally:
        db.close()
    return {"ok": True}