FROM python:3.12-slim

# wsdiscovery pulls in netifaces, which has no prebuilt wheel for Python 3.12
# and needs a C toolchain to compile from sdist. Install build deps, then
# remove them after pip install to keep the image slim.
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libc-dev python3-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y --auto-remove gcc libc-dev python3-dev
COPY . .

EXPOSE 8085
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8085"]
