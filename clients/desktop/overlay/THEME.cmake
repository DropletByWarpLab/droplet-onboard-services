# Droplet desktop client — CMake brand overlay.
#
# Copy this file into the root of your nextcloud/desktop fork and it
# overrides the default Nextcloud branding at configure time.
#
# Reference: upstream's NEXTCLOUD.cmake for the full variable list.

set(APPLICATION_NAME       "Droplet")
set(APPLICATION_SHORTNAME  "Droplet")
set(APPLICATION_EXECUTABLE "droplet")
set(APPLICATION_DOMAIN     "droplet.local")
set(APPLICATION_VENDOR     "Droplet")
set(APPLICATION_REV_DOMAIN "com.droplet.desktop")

# Virtual file suffix (on-demand placeholders in the OS file browser)
set(APPLICATION_VIRTUALFILE_SUFFIX "droplet" CACHE STRING "")

# Default server URL — pre-filled in the account wizard
set(APPLICATION_SERVER_URL "https://droplet.local/nextcloud" CACHE STRING "")

# Update channel (disable for self-hosted — updates come from GitHub Releases)
set(APPLICATION_UPDATE_URL "" CACHE STRING "")

# Colors (matches the web dashboard's indigo accent)
set(APPLICATION_WIZARD_HEADER_BACKGROUND_COLOR "#6366f1" CACHE STRING "")
set(APPLICATION_WIZARD_HEADER_TITLE_COLOR      "#ffffff" CACHE STRING "")

# URL scheme for pairing (registered in platform manifests)
set(APPLICATION_URI_HANDLER_SCHEME "droplet" CACHE STRING "")
