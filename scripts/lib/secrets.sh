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

  log_divider
}

_generate_mosquitto_passwd() {
  local mqtt_password="$1"
  local mqtt_user="${MQTT_USER:-droplet}"
  local passwd_file="$REPO_ROOT/docker/mosquitto_passwd"

  log_info "Generating MQTT password file..."

  # Use mosquitto_passwd from the Docker image to hash the password
  # This avoids requiring mosquitto tools on the host
  if run_docker run --rm \
    -v "$REPO_ROOT/docker:/tmp/mqtt" \
    eclipse-mosquitto:2 \
    sh -c "mosquitto_passwd -b -c /tmp/mqtt/mosquitto_passwd '$mqtt_user' '$mqtt_password'" 2>/dev/null; then
    chmod 600 "$passwd_file"
    log_success "MQTT password file generated"
  else
    # Fallback: create a plaintext file that setup can warn about
    log_warn "Could not generate hashed MQTT password — using plaintext fallback"
    printf "%s:%s\n" "$mqtt_user" "$mqtt_password" > "$passwd_file"
    chmod 600 "$passwd_file"
  fi
}

_write_mosquitto_conf() {
  local conf_file="$REPO_ROOT/docker/mosquitto.conf"

  cat > "$conf_file" << 'MQTTCONF'
listener 1883
password_file /mosquitto/config/passwd_dir/mosquitto_passwd
allow_anonymous false
persistence false
MQTTCONF

  log_success "Mosquitto configured with authentication"
}
