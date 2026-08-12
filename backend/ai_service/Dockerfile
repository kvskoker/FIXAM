FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 300 --retries 10 \
        --index-url https://download.pytorch.org/whl/cpu \
        torch && \
    pip install --no-cache-dir --timeout 300 --retries 10 \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["python", "main.py"]
