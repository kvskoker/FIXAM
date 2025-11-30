#!/bin/bash

echo "Starting AI Engine Setup..."

# Check if python3 is available
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 could not be found. Please install Python 3."
    exit 1
fi

# Optional: Create a virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

echo "Installing dependencies..."
pip install -r aiengine/requirements.txt

echo "Starting AI Engine on port 9000..."
python3 aiengine/main.py
