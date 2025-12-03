# AI Service Deployment Guide for Linux Server

## Issue Summary

The audio transcription service was failing on the Linux server with a "Killed" error, which indicates an **Out of Memory (OOM)** condition. The service was also showing deprecation warnings about `forced_decoder_ids` and language detection.

## What Was Fixed

1. **Reduced Memory Usage**:
   - Changed default Whisper model from `whisper-large-v3-turbo` (~1.5GB) to `whisper-base` (~140MB)
   - Reduced batch size from 16 to 1 to minimize memory consumption
   - Added configurable model selection via environment variable

2. **Fixed Deprecation Warnings**:
   - Added explicit `language='en'` parameter for English transcription
   - Added explicit `task='transcribe'` parameter
   - Disabled flash attention for better compatibility

3. **Improved Configuration**:
   - Made Whisper model selection configurable via `WHISPER_MODEL` environment variable
   - Added comprehensive documentation and troubleshooting guide

## Deployment Steps

### Step 1: Update the Code on Linux Server

Upload the updated `main.py` file to your Linux server:

```bash
# Navigate to the ai_service directory
cd /path/to/backend/ai_service

# Backup the current version
cp main.py main.py.backup

# Upload the new main.py (use scp, git pull, or your preferred method)
```

### Step 2: Configure Environment Variables

Create or update the `.env` file in the `backend` directory:

```bash
cd /path/to/backend
nano .env
```

Add the following configuration:

```env
# Hugging Face token (if required for your models)
HF_TOKEN=your_huggingface_token_here

# Whisper model selection (choose based on available RAM)
# For low-memory servers (< 1GB available): use whisper-base
WHISPER_MODEL=openai/whisper-base

# For servers with 1-2GB available: use whisper-small
# WHISPER_MODEL=openai/whisper-small

# For servers with 3GB+ available: use whisper-large-v3-turbo
# WHISPER_MODEL=openai/whisper-large-v3-turbo
```

### Step 3: Restart the Service

If using systemd:

```bash
sudo systemctl restart fixam-ai-service
sudo systemctl status fixam-ai-service
```

If running manually:

```bash
# Stop the current process (Ctrl+C or kill)
# Then restart:
cd /path/to/backend/ai_service
source venv/bin/activate  # if using virtual environment
python main.py
```

### Step 4: Verify the Service

Check the logs to ensure the service started successfully:

```bash
# For systemd:
sudo journalctl -u fixam-ai-service -f

# For manual run:
# Check the console output
```

You should see:
```
Loading Whisper model 'openai/whisper-base' on cpu (torch.float32)...
Whisper model loaded successfully!
Loading NudeNet detector...
NudeNet detector loaded successfully!
Loading Embedding Model: google/embeddinggemma-300m...
Embedding model loaded successfully on CPU!
```

### Step 5: Test the Transcription Endpoint

Test with a sample audio file:

```bash
curl -X POST "http://localhost:8000/transcribe" \
  -F "file=@test_audio.ogg" \
  -H "Content-Type: multipart/form-data"
```

Expected response:
```json
{
  "filename": "test_audio.ogg",
  "text": "Your transcribed text here"
}
```

## Memory Requirements by Model

| Model | RAM Required | Quality | Speed |
|-------|-------------|---------|-------|
| `whisper-base` | ~500MB | Good | Fast |
| `whisper-small` | ~1GB | Better | Medium |
| `whisper-medium` | ~1.5GB | Great | Slower |
| `whisper-large-v3-turbo` | ~2.5GB | Best | Slowest |

## Troubleshooting

### Still Getting "Killed" Error

1. **Check available memory**:
   ```bash
   free -h
   ```

2. **Try an even smaller model** (if using base):
   ```bash
   # In .env file:
   WHISPER_MODEL=openai/whisper-tiny
   ```

3. **Increase swap space** (temporary solution):
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

### Service Fails to Load Model

1. **Check HF_TOKEN is set correctly**:
   ```bash
   cat /path/to/backend/.env | grep HF_TOKEN
   ```

2. **Verify internet connectivity** (models download on first run):
   ```bash
   ping huggingface.co
   ```

3. **Check disk space** (models are cached locally):
   ```bash
   df -h
   ```

### Deprecation Warnings Still Appear

If you still see deprecation warnings after updating, ensure you're using the latest version of the code. The warnings should be resolved with the new `generate_kwargs` configuration.

## Performance Optimization Tips

1. **Use GPU if available**: The service will automatically use CUDA if available, which significantly improves performance.

2. **Adjust chunk_length_s**: For shorter audio files, you can reduce `chunk_length_s` in the pipeline configuration.

3. **Monitor resource usage**:
   ```bash
   htop  # or top
   ```

## Rollback Instructions

If you need to rollback to the previous version:

```bash
cd /path/to/backend/ai_service
cp main.py.backup main.py
sudo systemctl restart fixam-ai-service
```

## Support

For additional issues, check:
- Service logs: `sudo journalctl -u fixam-ai-service -n 100`
- System logs: `sudo dmesg | grep -i kill`
- Memory usage: `free -h` and `htop`
