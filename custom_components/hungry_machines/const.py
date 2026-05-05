"""Constants for the Hungry Machines integration."""
from __future__ import annotations

DOMAIN = "hungry_machines"
INTEGRATION_NAME = "Hungry Machines"

PANEL_URL_PATH = "hungry-machines"
PANEL_TITLE = "Hungry Machines"
PANEL_ICON = "mdi:lightning-bolt"
PANEL_NAME = "hungry-machines-panel"

SCRIPT_FILENAME = "hungry-machines.js"
SCRIPT_URL = f"/{DOMAIN}/{SCRIPT_FILENAME}"

API_BASE_URL = "https://api.hungrymachines.io"

CONF_EMAIL = "email"
CONF_PASSWORD = "password"
CONF_ACCESS_TOKEN = "access_token"
CONF_REFRESH_TOKEN = "refresh_token"
CONF_EXPIRES_AT = "expires_at"
CONF_USER_ID = "user_id"
CONF_CLIMATE_ENTITY = "climate_entity"
