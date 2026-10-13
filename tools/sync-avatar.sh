#!/bin/bash
# Harvis'in karakteri Harvis deposunda yaşar (avatar/avatar.js); ada aynı dosyanın bir kopyasını taşır,
# çünkü eklenti paketi kendi içinde tam olmalı. Karakteri orada değiştir, sonra bunu çalıştır.
set -eu
cd "$(dirname "$0")/.."
cp "${HARVIS:-$HOME/Masaüstü/Projects/Github/Harvis}/avatar/avatar.js" avatar.js
echo "avatar.js güncellendi"
