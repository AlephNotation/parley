# Primary workload of the Parley computer: waits for a release in /app, then keeps the server
# running. Killing the pid in /data/server.pid makes it start again with whatever is in /app.
mkdir -p /app /data
while :; do
  if [ -f /app/src/index.ts ]; then
    cd /app && bun install --production >/dev/null 2>&1
    bun src/index.ts &
    echo $! > /data/server.pid
    wait $!
  fi
  sleep 2
done
