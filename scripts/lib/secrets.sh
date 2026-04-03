#!/usr/bin/env bash
# secrets.sh — Generate device-unique secrets and write .env file.
# Source this file; do not execute directly.

# Generate a random alphanumeric password of given length.
_gen_password() {
  local length="${1:-24}"
  openssl rand -base64 48 | tr -d '=/+\n' | head -c "$length"
}

# Generate a Fernet-compatible base64 key.
_gen_fernet_key() {
  openssl rand -base64 32
}

generate_env() {
  local env_file="$REPO_ROOT/.env"
  local env_example="$REPO_ROOT/.env.example"

  # --- Check for existing .env ---
  if [ -f "$env_file" ] && [ "${REGENERATE_ENV:-false}" != "true" ]; then
    log_success ".env already exists — skipping secret generation"
    log_info "  To regenerate: ./scripts/setup.sh --regenerate-env"
    log_divider
    return 0
  fi

  # --- Backup existing .env if regenerating ---
  if [ -f "$env_file" ] && [ "${REGENERATE_ENV:-false}" = "true" ]; then
    local backup="$env_file.bak.$(date +%s)"
    cp "$env_file" "$backup"
    log_info "Backed up existing .env to $backup"
  fi

  # --- Ensure template exists ---
  if [ ! -f "$env_example" ]; then
    log_error ".env.example not found at $env_example"
    log_error "  This file is required to generate device secrets."
    log_error "  Try: git pull origin main"
    return 1
  fi

  log_info "Generating device-unique secrets..."

  # --- Generate all secrets ---
  local pg_password redis_password mqtt_password nc_password device_secret
  pg_password=$(_gen_password 24)
  redis_password=$(_gen_password 24)
  mqtt_password=$(_gen_password 24)
  nc_password=$(_gen_password 24)
  device_secret=$(_gen_fernet_key)

  # --- Write .env from template ---
  cp "$env_example" "$env_file"

  # Substitute all 'change-me' placeholders with generated values
  # PostgreSQL
  sed -i.tmp "s|POSTGRES_PASSWORD=change-me|POSTGRES_PASSWORD=$pg_password|g" "$env_file"
  sed -i.tmp "s|postgresql://droplet:change-me@|postgresql://droplet:${pg_password}@|g" "$env_file"

  # Redis
  sed -i.tmp "s|REDIS_PASSWORD=change-me|REDIS_PASSWORD=$redis_password|g" "$env_file"
  sed -i.tmp "s|redis://:change-me@|redis://:${redis_password}@|g" "$env_file"

  # MQTT
  sed -i.tmp "s|MQTT_PASSWORD=change-me|MQTT_PASSWORD=$mqtt_password|g" "$env_file"
  sed -i.tmp "s|mqtt://droplet:change-me@|mqtt://droplet:${mqtt_password}@|g" "$env_file"

  # Nextcloud admin
  sed -i.tmp "s|NEXTCLOUD_ADMIN_PASSWORD=change-me|NEXTCLOUD_ADMIN_PASSWORD=$nc_password|g" "$env_file"

  # BYOK encryption key
  sed -i.tmp "s|DEVICE_SECRET=change-me|DEVICE_SECRET=$device_secret|g" "$env_file"

  # Clean up sed backup files
  rm -f "$env_file.tmp"

  # --- Restrict permissions ---
  chmod 600 "$env_file"

  log_success "Generated unique secrets:"
  log_info "  POSTGRES_PASSWORD : ${pg_password:0:4}****"
  log_info "  REDIS_PASSWORD    : ${redis_password:0:4}****"
  log_info "  MQTT_PASSWORD     : ${mqtt_password:0:4}****"
  log_info "  NEXTCLOUD_ADMIN   : ${nc_password:0:4}****"
  log_info "  DEVICE_SECRET     : ${device_secret:0:8}****"
  log_success "Secrets written to $env_file (chmod 600)"

  # --- Generate Mosquitto password file ---
  _generate_mosquitto_passwd "$mqtt_password"

  # --- Write authenticated mosquitto.conf ---
  _write_mosquitto_conf

  # --- Generate TLS certificate for HTTPS ---
  _generate_tls_cert

  log_divider
}

_generate_mosquitto_passwd() {
  local mqtt_password="$1"
  local mqtt_user="${MQTT_USER:-droplet}"
  local passwd_dir="$REPO_ROOT/docker/mosquitto_passwd_dir"
  local passwd_file="$passwd_dir/mosquitto_passwd"

  log_info "Generating MQTT password file..."

  # Ensure the target directory exists (this is what docker-compose.yml mounts)
  mkdir -p "$passwd_dir"

  # Clean up any root-owned file from a previous failed run
  if [ -f "$passwd_file" ] && [ ! -w "$passwd_file" ]; then
    sudo rm -f "$passwd_file"
  fi

  # Write directly to the final mount location — no intermediate copy needed.
  # Docker containers create files as root in bind mounts, so we fix ownership after.
  if run_docker run --rm \
    -v "$passwd_dir:/tmp/mqtt" \
    eclipse-mosquitto:2 \
    sh -c "mosquitto_passwd -b -c /tmp/mqtt/mosquitto_passwd '$mqtt_user' '$mqtt_password'"; then
    # Docker creates files as root — fix ownership (mandatory, fail loudly)
    sudo chown "$(id -u):$(id -g)" "$passwd_file"
    chmod 600 "$passwd_file"
    log_success "MQTT password file generated"
  else
    # Fallback: create a plaintext file (no Docker needed)
    log_warn "Could not generate hashed MQTT password — using plaintext fallback"
    printf "%s:%s\n" "$mqtt_user" "$mqtt_password" > "$passwd_file"
    chmod 600 "$passwd_file"
  fi

  # Clean up stale intermediate file from old code path
  if [ -f "$REPO_ROOT/docker/mosquitto_passwd" ]; then
    rm -f "$REPO_ROOT/docker/mosquitto_passwd" 2>/dev/null || sudo rm -f "$REPO_ROOT/docker/mosquitto_passwd"
  fi
}

_write_mosquitto_conf() {
  local conf_file="$REPO_ROOT/docker/mosquitto.conf"

  # Clean up root-owned file from a previous failed run
  if [ -f "$conf_file" ] && [ ! -w "$conf_file" ]; then
    sudo rm -f "$conf_file"
  fi

  cat > "$conf_file" << 'MQTTCONF'
listener 1883
password_file /mosquitto/config/passwd_dir/mosquitto_passwd
allow_anonymous false
persistence false
MQTTCONF

  log_success "Mosquitto configured with authentication"
}

_generate_tls_cert() {
  local cert_dir="$REPO_ROOT/docker/certs"
  local cert_file="$cert_dir/droplet.crt"
  local key_file="$cert_dir/droplet.key"

  # Skip if cert already exists and is still valid
  if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    if openssl x509 -checkend 86400 -noout -in "$cert_file" >/dev/null 2>&1; then
      log_success "TLS certificate already exists and is valid — skipping"
      return 0
    fi
    log_warn "TLS certificate expired or invalid — regenerating"
  fi

  log_info "Generating self-signed TLS certificate (valid 10 years)..."
  mkdir -p "$cert_dir"

  # Collect Subject Alternative Names: localhost + all local IPv4 addresses
  local san="DNS:localhost"
  # Add the hostname
  local hn
  hn=$(hostname 2>/dev/null || echo "droplet")
  san="$san,DNS:$hn,DNS:${hn}.local"

  # Add all non-loopback IPv4 addresses
  local ip
  for ip in $(ip -4 addr show scope global 2>/dev/null \
              | grep -oP 'inet \K[\d.]+' || \
              ifconfig 2>/dev/null \
              | grep -oE 'inet (addr:)?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
              | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
              | grep -v '^127\.'); do
    san="$san,IP:$ip"
  done
  # Always include loopback
  san="$san,IP:127.0.0.1"

  openssl req -x509 -nodes -newkey rsa:2048 \
    -days 3650 \
    -keyout "$key_file" \
    -out "$cert_file" \
    -subj "/CN=Droplet Edge Device" \
    -addext "subjectAltName=$san" \
    2>/dev/null

  chmod 600 "$key_file"
  chmod 644 "$cert_file"

  log_success "TLS certificate generated:"
  log_info "  Cert: $cert_file"
  log_info "  Key:  $key_file"
  log_info "  SANs: $san"
}
