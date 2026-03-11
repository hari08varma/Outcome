FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for LightGBM
RUN apt-get update && apt-get install -y \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Health check for Railway cron
HEALTHCHECK --interval=30s --timeout=10s \
  CMD python -c "import lightgbm; print('ok')"

# Default: run training
CMD ["python", "train_world_model.py"]
