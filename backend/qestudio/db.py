"""SQLite persistence (SQLAlchemy 2.0, WAL mode)."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, ClassVar

from sqlalchemy import JSON, DateTime, Integer, String, Text, TypeDecorator, create_engine, event, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .config import get_env


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class UTCDateTime(TypeDecorator):
    """SQLite stores naive datetimes; always hand back timezone-aware UTC values."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


class Base(DeclarativeBase):
    type_annotation_map: ClassVar[dict[Any, Any]] = {dict[str, Any]: JSON, list[Any]: JSON}


class StructureRow(Base):
    __tablename__ = "structures"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    formula: Mapped[str] = mapped_column(String(200), default="")
    natoms: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class DocumentRow(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    program: Mapped[str] = mapped_column(String(32), default="pw")
    content: Mapped[str] = mapped_column(Text, default="")
    structure_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class ConnectionRow(Base):
    __tablename__ = "connections"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))  # local | ssh | jupyter
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class JobRow(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    connection_id: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="created")
    # created | submitting | queued | running | done | failed | cancelled | lost
    kind: Mapped[str] = mapped_column(String(32), default="custom")  # scf, bands, dos, phonon, convergence, eos...
    steps: Mapped[list[Any]] = mapped_column(JSON, default=list)
    resources: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    workflow: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    remote_dir: Mapped[str] = mapped_column(String(1000), default="")
    scheduler: Mapped[str] = mapped_column(String(16), default="direct")
    remote_job_id: Mapped[str] = mapped_column(String(64), default="")
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")
    structure_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    fetched: Mapped[int] = mapped_column(Integer, default=0)  # results downloaded to cache
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class KVRow(Base):
    __tablename__ = "kv"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON)


_engine = None
_Session: sessionmaker[Session] | None = None
_lock = threading.Lock()


def init_db(url: str | None = None) -> None:
    global _engine, _Session
    with _lock:
        if _engine is not None and url is None:
            return
        url = url or f"sqlite:///{get_env().db_path}"
        _engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(_engine, "connect")
        def _pragmas(dbapi_conn, _rec):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

        Base.metadata.create_all(_engine)
        _Session = sessionmaker(_engine, expire_on_commit=False)


def reset_engine() -> None:
    """Dispose the engine (tests / switching data directories)."""
    global _engine, _Session
    with _lock:
        if _engine is not None:
            _engine.dispose()
        _engine = None
        _Session = None


@contextmanager
def session() -> Iterator[Session]:
    if _Session is None:
        init_db()
    assert _Session is not None
    s = _Session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def kv_get(key: str, default: Any = None) -> Any:
    with session() as s:
        row = s.get(KVRow, key)
        return row.value.get("v") if row else default


def kv_set(key: str, value: Any) -> None:
    with session() as s:
        row = s.get(KVRow, key)
        if row:
            row.value = {"v": value}
        else:
            s.add(KVRow(key=key, value={"v": value}))


__all__ = [
    "Base",
    "ConnectionRow",
    "DocumentRow",
    "JobRow",
    "KVRow",
    "StructureRow",
    "init_db",
    "kv_get",
    "kv_set",
    "new_id",
    "reset_engine",
    "select",
    "session",
    "utcnow",
]
