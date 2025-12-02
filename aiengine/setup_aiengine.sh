#!/bin/bash

# Exit on error
set -e

echo "=========================================="
echo "   Fixam AI Engine Setup Script (Linux)   "
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (use sudo)"
  exit 1
fi

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
echo "Detected installation directory: $SCRIPT_DIR"

# Get the actual user (not root) to own the files
ACTUAL_USER=${SUDO_USER:-$USER}
ACTUAL_GROUP=$(id -gn $ACTUAL_USER)
echo "Installing for user: $ACTUAL_USER"

# 1. Install System Dependencies
echo "------------------------------------------"
echo "1. Installing System Dependencies..."
apt-get update
apt-get install -y python3 python3-pip python3-venv

# 2. Create Virtual Environment
echo "------------------------------------------"
echo "2. Setting up Python Virtual Environment..."
VENV_DIR="$SCRIPT_DIR/venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
    # Fix ownership since we are running as root
    chown -R $ACTUAL_USER:$ACTUAL_GROUP "$VENV_DIR"
else
    echo "Virtual environment already exists."
fi

# 3. Install Python Requirements
echo "------------------------------------------"
echo "3. Installing Python Dependencies..."
# Run pip as the actual user to avoid permission issues inside venv
sudo -u $ACTUAL_USER "$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

# 4. Configure Systemd Service
echo "------------------------------------------"
echo "4. Configuring Systemd Service..."

SERVICE_FILE="$SCRIPT_DIR/aiengine.service"
SYSTEM_SERVICE_FILE="/etc/systemd/system/aiengine.service"

if [ -f "$SERVICE_FILE" ]; then
    echo "Updating service file with correct paths..."
    
    # Create a temporary file
    cp "$SERVICE_FILE" "${SERVICE_FILE}.tmp"
    
    # Replace placeholders with actual values
    sed -i "s|User=ubuntu|User=$ACTUAL_USER|g" "${SERVICE_FILE}.tmp"
    sed -i "s|Group=ubuntu|Group=$ACTUAL_GROUP|g" "${SERVICE_FILE}.tmp"
    sed -i "s|WorkingDirectory=/path/to/your/project/aiengine|WorkingDirectory=$SCRIPT_DIR|g" "${SERVICE_FILE}.tmp"
    # Try to get token from environment variable or backend .env
    HF_TOKEN="$HUGGINGFACE_API_KEY"
    
    if [ -z "$HF_TOKEN" ]; then
        BACKEND_ENV="$SCRIPT_DIR/../backend/.env"
        if [ -f "$BACKEND_ENV" ]; then
            echo "Looking for HUGGINGFACE_API_KEY in $BACKEND_ENV..."
            # Extract HUGGINGFACE_API_KEY from .env (handle potential carriage returns)
            HF_TOKEN=$(grep "^HUGGINGFACE_API_KEY=" "$BACKEND_ENV" | cut -d '=' -f2 | tr -d '"' | tr -d "'" | tr -d '\r')
        fi
    fi

    if [ -z "$HF_TOKEN" ]; then
        read -p "Enter your Hugging Face API Token (leave blank if not needed): " HF_TOKEN
    else
        echo "Found Hugging Face Token."
    fi
    
    if [ ! -z "$HF_TOKEN" ]; then
        echo "Configuring Hugging Face Token..."
        # Add Environment variable to service file
        # Check if Environment line already exists, if so replace it, else append after ExecStart
        if grep -q "Environment=HUGGINGFACE_API_KEY=" "${SERVICE_FILE}.tmp"; then
            sed -i "s|Environment=HUGGINGFACE_API_KEY=.*|Environment=HUGGINGFACE_API_KEY=$HF_TOKEN|g" "${SERVICE_FILE}.tmp"
        else
            sed -i "/ExecStart=/a Environment=HUGGINGFACE_API_KEY=$HF_TOKEN" "${SERVICE_FILE}.tmp"
        fi
    fi

    sed -i "s|ExecStart=/usr/bin/python3 main.py|ExecStart=$VENV_DIR/bin/python main.py|g" "${SERVICE_FILE}.tmp"
    
    # Move to systemd directory
    mv "${SERVICE_FILE}.tmp" "$SYSTEM_SERVICE_FILE"
    
    echo "Service file installed to $SYSTEM_SERVICE_FILE"
else
    echo "Error: aiengine.service file not found in $SCRIPT_DIR"
    exit 1
fi

# 5. Start Service
echo "------------------------------------------"
echo "5. Starting Service..."
systemctl daemon-reload
systemctl enable aiengine
systemctl restart aiengine

echo "=========================================="
echo "   Setup Complete!                        "
echo "=========================================="
echo "Check status with: sudo systemctl status aiengine"
