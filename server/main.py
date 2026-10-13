import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

DB_PATH = Path(__file__).parent / "notion.db"


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