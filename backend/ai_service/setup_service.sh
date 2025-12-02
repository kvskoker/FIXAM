#!/bin/bash

# Define service name and directory
SERVICE_NAME="fixam-ai-service"
SERVICE_DIR="$(pwd)"
VENV_DIR="$SERVICE_DIR/venv"
USER_NAME=$(whoami)

echo "Setting up $SERVICE_NAME..."

# 1. Install System Dependencies (Ubuntu/Debian)
echo "Installing system dependencies..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y python3-venv python3-pip ffmpeg
else
    echo "Warning: apt-get not found. Please ensure python3-venv, python3-pip, and ffmpeg are installed."
fi

# 2. Setup Virtual Environment
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# 3. Install Python Dependencies
echo "Installing Python dependencies..."
source "$VENV_DIR/bin/activate"
pip install --upgrade pip
pip install -r requirements.txt

# 4. Create Systemd Service File
echo "Creating systemd service file..."
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

sudo bash -c "cat > $SERVICE_FILE" <<EOL
[Unit]
Description=FIXAM AI Service (NudeNet, Whisper, EmbeddingGemma)
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$SERVICE_DIR
ExecStart=$VENV_DIR/bin/python main.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
# Environment=HF_TOKEN=your_huggingface_token_here

[Install]
WantedBy=multi-user.target
EOL

# 5. Enable and Start Service
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable $SERVICE_NAME
sudo systemctl start $SERVICE_NAME

echo "Setup complete! Service status:"
sudo systemctl status $SERVICE_NAME --no-pager
