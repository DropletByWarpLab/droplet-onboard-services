FROM python:3.12-slim

WORKDIR /app

# System deps for pdfplumber (poppler) and psycopg2
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libpq-dev gcc && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy proto-generated gRPC stubs (built by the ai-gateway's gen script)
# For now we regenerate them locally from the shared proto.
COPY proto/ /app/proto/
RUN python -m grpc_tools.protoc \
    -I/app/proto \
    --python_out=/app/grpc_generated \
    --grpc_python_out=/app/grpc_generated \
    /app/proto/inference.proto || true
RUN mkdir -p /app/grpc_generated && touch /app/grpc_generated/__init__.py

COPY . .

CMD ["python", "main.py"]
