// Runs in a child so an unhandled socket error is a real process failure.
const { createServer } = require("node:http");
const { createRequire } = require("node:module");
const { setTimeout: sleep } = require("node:timers/promises");
const discordRequire = createRequire(require.resolve("discord.js"));
const { WebSocketShard, DefaultWebSocketManagerOptions } =
  discordRequire("@discordjs/ws");

(async () => {
  const sockets = new Set();
  let upgraded;
  const upgrade = new Promise((resolve) => {
    upgraded = resolve;
  });
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("end", () => socket.destroy());
    socket.on("data", () => {}); // Drain EOF after the abandoned handshake.
  });
  server.on("upgrade", () => upgraded());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shard = new WebSocketShard(
    {
      options: {
        ...DefaultWebSocketManagerOptions,
        token: "test-only",
        intents: 0,
        shardCount: 1,
        gatewayInformation: { url: "ws://127.0.0.1:" + server.address().port },
        handshakeTimeout: 100,
        helloTimeout: 1000
      },
      retrieveSessionInfo: async () => null,
      updateSessionInfo: async () => {},
      waitForIdentify: async () => {}
    },
    0
  );
  shard.on("error", () => {});
  void shard.connect().catch(() => {});
  await upgrade;
  await shard.destroy();
  await sleep(200);
  if (sockets.size) throw new Error("Retired connecting socket is still open");
  process.stdout.write("retired-handshake-closed\n");
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
