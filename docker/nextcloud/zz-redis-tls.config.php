<?php
/**
 * WARP-234 — Nextcloud Redis over TLS with a least-privilege ACL identity.
 *
 * Bind-mounted read-only into /var/www/html/config/. Nextcloud loads
 * config/*.config.php in lexicographic order and later files override
 * earlier keys wholesale, so this `zz-` file's `redis` array replaces the
 * plaintext one the image entrypoint writes from REDIS_HOST
 * (redis.config.php → host cache:6379, no TLS).
 *
 * - `tls://` scheme + ssl_context.cafile: phpredis verifies the cache
 *   server cert against the WARP-236 compose-internal CA (bundle mounted
 *   at /data/service-tls).
 * - `user` => the `nextcloud` ACL identity from data/secrets/redis/users.acl
 *   (scripts/lib/secrets.sh); password stays REDIS_HOST_PASSWORD, the env
 *   name the Nextcloud image has always used.
 */
$CONFIG = [
  'memcache.distributed' => '\OC\Memcache\Redis',
  'memcache.locking' => '\OC\Memcache\Redis',
  'redis' => [
    'host' => 'tls://cache',
    'port' => 6380,
    'user' => 'nextcloud',
    'password' => getenv('REDIS_HOST_PASSWORD') ?: '',
    'ssl_context' => [
      'cafile' => '/data/service-tls/ca.pem',
      'verify_peer' => true,
      'verify_peer_name' => true,
    ],
  ],
];
