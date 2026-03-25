import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import dismissed, documents, provenance, suggestions, timeline, youness

# Load ANTHROPIC_API_KEY (and any other vars) from backend/.env if present.
# This must run before any route handlers that use the API key.
load_dotenv()


# asynccontextmanager turns this into a FastAPI "lifespan" handler.
# Code before 'yield' runs at startup; code after 'yield' runs at shutdown.
# This replaces the older @app.on_event("startup") pattern.
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Provenance API", lifespan=lifespan)

# Allow cross-origin requests from the Vite dev server on port 5173
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dismissed.router)
app.include_router(documents.router)
app.include_router(provenance.router)
app.include_router(suggestions.router)
app.include_router(youness.router)
app.include_router(timeline.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
