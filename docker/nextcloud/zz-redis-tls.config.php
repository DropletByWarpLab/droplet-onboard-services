<?php
/**
 * WARP-234 / WARP-1607 — Nextcloud Redis over TLS with a least-privilege
 * ACL identity.
 *
 * Bind-mounted read-only into /var/www/html/config/. Nextcloud loads
 * config/*.config.php in natural-sort order and later files override
 * earlier keys wholesale, so this `zz-` file's `redis` array replaces the
 * plaintext one the image's baked redis.config.php builds from REDIS_HOST.
 *
 * - `tls://` scheme + ssl_context.cafile: phpredis verifies the cache
 *   server cert against the WARP-236 compose-internal CA (bundle mounted
 *   at /data/service-tls).
 * - `user` => the `nextcloud` ACL identity from data/secrets/redis/users.acl
 *   (scripts/lib/secrets.sh); password stays REDIS_HOST_PASSWORD, the env
 *   name the Nextcloud image has always used.
 *
 * WARP-1607 — the endpoint is deliberately NOT written here. It comes from
 * the env contract on the `nextcloud` service in docker/docker-compose.yml,
 * which is the single source of truth shared with PHP's session handler
 * (docker/nextcloud/zz-redis-session.ini). Nextcloud talks to Redis from
 * BOTH surfaces, and hardcoding the endpoint in each is exactly how they
 * silently drifted apart: WARP-234 migrated this file and left sessions on
 * the retired plaintext listener, breaking every session write and — via an
 * opaque `Groupfolder add group: 500` — department provisioning (ADR-029).
 *
 * There are deliberately NO literal fallbacks for the endpoint. A default
 * here would be a second copy of the truth and therefore a second chance to
 * drift; a missing variable is a wiring bug and must fail loudly and
 * legibly instead of quietly connecting somewhere unintended. The password
 * keeps its WARP-234 `?: ''` handling — that behaviour is not this ticket's
 * to change. scripts/test-security.sh (Test 21) pins that both surfaces
 * resolve from the identical set of variables.
 *
 * The whole block runs inside a closure so nothing leaks into the scope of
 * \OC\Config::readData(), which `include`s this file inside its own method.
 */
$CONFIG = (static function (): array {
    $endpoint = [
        'REDIS_TLS_SCHEME' => getenv('REDIS_TLS_SCHEME'),
        'REDIS_HOST' => getenv('REDIS_HOST'),
        'REDIS_HOST_PORT' => getenv('REDIS_HOST_PORT'),
        'REDIS_HOST_USER' => getenv('REDIS_HOST_USER'),
        'REDIS_TLS_CAFILE' => getenv('REDIS_TLS_CAFILE'),
    ];

    foreach ($endpoint as $name => $value) {
        if ($value === false || $value === '') {
            throw new \RuntimeException(
                'Nextcloud Redis config: ' . $name . ' is unset. The Redis endpoint is '
                . 'defined once, on the `nextcloud` service in docker/docker-compose.yml, '
                . 'and is shared with the PHP session handler '
                . '(/usr/local/etc/php/conf.d/zz-redis-session.ini).'
            );
        }
    }

    return [
        'memcache.distributed' => '\OC\Memcache\Redis',
        'memcache.locking' => '\OC\Memcache\Redis',
        'redis' => [
            'host' => $endpoint['REDIS_TLS_SCHEME'] . '://' . $endpoint['REDIS_HOST'],
            'port' => (int)$endpoint['REDIS_HOST_PORT'],
            'user' => $endpoint['REDIS_HOST_USER'],
            'password' => getenv('REDIS_HOST_PASSWORD') ?: '',
            'ssl_context' => [
                'cafile' => $endpoint['REDIS_TLS_CAFILE'],
                'verify_peer' => true,
                'verify_peer_name' => true,
            ],
        ],
    ];
})();
