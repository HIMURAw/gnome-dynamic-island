#!/bin/bash
# Harvis'in karakteri Harvis deposunda yaşar (avatar/robot.js); ada aynı dosyanın bir kopyasını taşır,
# çünkü eklenti paketi kendi içinde tam olmalı. Karakteri orada değiştir, sonra bunu çalıştır.
set -eu
cd "$(dirname "$0")/.."
cp "${HARVIS:-$HOME/Masaüstü/Projects/Github/Harvis}/avatar/robot.js" robot.js
echo "robot.js güncellendi"
