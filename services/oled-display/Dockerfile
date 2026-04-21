FROM python:3.12-slim

# System deps for SPI/GPIO, framebuffer writes, Pillow, and evdev touch input.
# gcc + python3-dev + linux-headers are needed to build the spidev + evdev wheels
# on aarch64 (no prebuilt wheels on PyPI for Python 3.12).
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc python3-dev linux-libc-dev \
    libfreetype6-dev libjpeg62-turbo-dev libopenjp2-7 \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8082
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8082"]
