FROM python:3.12-slim

WORKDIR /app

# System deps for pdfplumber (poppler) and psycopg2
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libpq-dev gcc && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy proto from the monorepo root (via Docker build context or volume)
# and generate gRPC stubs at build time.
COPY proto/ /app/proto/
RUN mkdir -p /app/grpc_generated && \
    touch /app/grpc_generated/__init__.py && \
    python -m grpc_tools.protoc \
      -I/app/proto \
      --python_out=/app/grpc_generated \
      --grpc_python_out=/app/grpc_generated \
      /app/proto/inference.proto

COPY . .

CMD ["python", "main.py"]
