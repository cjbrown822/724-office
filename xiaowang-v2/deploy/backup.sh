#!/bin/bash
# 每日库一致快照备份：先 wal_checkpoint(TRUNCATE) 把 WAL 落主库，再 cp。
# 保留 7 天（按星期几 1-7 轮转覆盖）。由 crontab 04:17 触发。
# 多租户：每个租户的库都要备（2026-07-07 前只备子淇的，朋友库曾零备份+WAL 积压——
# 新增租户时把库路径加进 DBS，verify_tenant 的纪律同款：随租户变的东西要进清单）。
# 备份含全部对话/ESM/记忆等隐私数据，umask 077 + chmod 600 收紧到仅 owner 可读。
umask 077
DBS="/opt/xiaowang-v2/v2.db /opt/xiaowang-v2/tenants/friend/v2.db"
for db in $DBS; do
  if [ ! -f "$db" ]; then echo "[backup] $(date '+%F %T') SKIP 库不存在: $db"; continue; fi
  /usr/local/bin/node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$db');d.exec('PRAGMA busy_timeout=10000');d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();" || { echo "[backup] $(date '+%F %T') FAIL checkpoint: $db"; continue; }
  cp "$db" "$db.bak.$(date +%u)" && chmod 600 "$db.bak.$(date +%u)" \
    && echo "[backup] $(date '+%F %T') -> $db.bak.$(date +%u)" \
    || echo "[backup] $(date '+%F %T') FAIL cp: $db"
done
