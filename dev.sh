#!/bin/bash

# Start backend
cd ~/projects/provenance/backend && .venv/bin/python3.12 -m uvicorn main:app --port 8000 --reload &
BACKEND_PID=$!

# Start frontend
cd ~/projects/provenance/frontend && npm run dev &
FRONTEND_PID=$!

# Shut down both on Ctrl+C
trap "kill $BACKEND_PID $FRONTEND_PID" EXIT

wait
