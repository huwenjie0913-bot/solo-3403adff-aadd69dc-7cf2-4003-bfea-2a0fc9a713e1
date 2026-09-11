"""SQLite persistence for saved design versions."""
import json
import sqlite3
from datetime import datetime

DB_PATH = "designs.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created TEXT NOT NULL,
            name TEXT NOT NULL,
            topology TEXT NOT NULL,
            note TEXT DEFAULT '',
            data TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def list_versions():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, created, name, topology, note FROM versions "
        "ORDER BY id DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_version(name, topology, note, data):
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO versions (created, name, topology, note, data) "
        "VALUES (?,?,?,?,?)",
        (datetime.utcnow().isoformat(timespec="seconds") + "Z",
         name, topology, note, json.dumps(data, ensure_ascii=False)),
    )
    conn.commit()
    vid = cur.lastrowid
    conn.close()
    return vid


def get_version(vid):
    conn = get_db()
    row = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    conn.close()
    if row is None:
        return None
    d = dict(row)
    d["data"] = json.loads(d["data"])
    return d


def delete_version(vid):
    conn = get_db()
    conn.execute("DELETE FROM versions WHERE id=?", (vid,))
    conn.commit()
    conn.close()
