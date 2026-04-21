FROM python:3.12-slim

# System deps are just Pillow's native libs + DejaVu for the on-screen font.
# The old SPI/GPIO/evdev build chain (gcc + python3-dev + linux-libc-dev) is
# gone along with spidev/evdev/Jetson.GPIO/luma.lcd — PyPortal needs only
# pyserial, which ships as a pure-Python wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libfreetype6-dev libjpeg62-turbo-dev libopenjp2-7 \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8082
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8082"]
