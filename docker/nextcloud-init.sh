#!/bin/bash
# Post-installation hook: replace default skeleton files with Droplet guide.
# This runs once after the initial Nextcloud auto-install.
php /var/www/html/occ config:system:set skeletondirectory --value="/skeleton"
