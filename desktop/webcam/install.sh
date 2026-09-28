#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
USER_HOME=/home/tdulshan

install -Dm755 "$HERE/s20-webcam" "$USER_HOME/.local/bin/s20-webcam"
install -Dm755 "$HERE/webcam_bridge.py" "$USER_HOME/.local/lib/s20-webcam/webcam_bridge.py"
install -Dm644 "$HERE/s20-wide-webcam.service" \
    "$USER_HOME/.config/systemd/user/s20-wide-webcam.service"
install -Dm644 "$HERE/s20-ultrawide-webcam.service" \
    "$USER_HOME/.config/systemd/user/s20-ultrawide-webcam.service"
install -Dm644 "$HERE/s20-webcam-bridge.service" \
    "$USER_HOME/.config/systemd/user/s20-webcam-bridge.service"

if [ ! -e "$USER_HOME/.config/s20-webcam/settings.conf" ]; then
    install -Dm600 "$HERE/settings.conf" "$USER_HOME/.config/s20-webcam/settings.conf"
fi

systemctl --user daemon-reload
systemctl --user enable --now s20-webcam-bridge.service

printf '%s\n' "S20 webcam bridge: http://127.0.0.1:8765/state"
