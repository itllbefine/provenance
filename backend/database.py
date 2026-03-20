import os
import aiosqlite

# Store the SQLite file in the backend directory
DB_PATH = os.path.join(os.path.dirname(__file__), "provenance.db")


async def get_db():
    """
    FastAPI dependency that provides a database connection for one request.

    FastAPI's Depends() system calls this function automatically and passes the
    yielded value to route handlers. The 'async with' block ensures the
    connection is closed when the request finishes, even if an error occurs.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        # Row factory lets us access columns by name (e.g. row["id"])
        # instead of by position (row[0])
        db.row_factory = aiosqlite.Row
        yield db


async def init_db() -> None:
    """Create all tables if they don't exist yet. Called once at app startup."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL DEFAULT 'Untitled',
                content     TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
        """)

        # Each row is one provenance span — a contiguous run of text that
        # shares a single authorship record. Spans are linked to documents
        # and can reference a parent span they were derived from.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS provenance_spans (
                id              TEXT PRIMARY KEY,
                document_id     TEXT NOT NULL REFERENCES documents(id),
                text            TEXT NOT NULL,
                origin          TEXT NOT NULL,
                author          TEXT NOT NULL,
                timestamp       TEXT NOT NULL,
                edit_type       TEXT NOT NULL,
                parent_span_id  TEXT,
                ai_model        TEXT,
                confidence      REAL NOT NULL DEFAULT 1.0,
                history         TEXT NOT NULL DEFAULT '[]'
            )
        """)

        # Each row is one raw edit event captured from a ProseMirror transaction.
        # This is the append-only event log — the source of truth for provenance.
        await db.execute("""
            CREATE TABLE IF NOT EXISTS provenance_events (
                id            TEXT PRIMARY KEY,
                document_id   TEXT NOT NULL REFERENCES documents(id),
                event_type    TEXT NOT NULL,
                from_pos      INTEGER NOT NULL,
                to_pos        INTEGER NOT NULL,
                inserted_text TEXT NOT NULL DEFAULT '',
                deleted_text  TEXT NOT NULL DEFAULT '',
                author        TEXT NOT NULL,
                timestamp     TEXT NOT NULL
            )
        """)

        await db.commit()
