#!/bin/bash
set -e

echo "Starting Job Application Assistant Server..."
echo ""

# Check .env
if [ ! -f ".env" ]; then
    echo "[ERROR] .env file not found!"
    echo "Copy .env.example to .env and fill in your API keys."
    exit 1
fi

# Install dependencies
echo "Checking dependencies..."
pip install -r requirements.txt -q

echo ""
echo "Server starting on http://127.0.0.1:8765"
echo "Load the extension: Chrome > Extensions > Load unpacked > select extension/ folder"
echo ""

cd tools
python server.py
