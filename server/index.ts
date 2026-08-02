import { createGameServer } from './app';

const port = Number(process.env.PORT ?? 2567);

export const server = createGameServer();

server.listen(port)
  .then(() => {
    console.log(`[server] Duelcade listening on port ${port}`);
  })
  .catch((error: unknown) => {
    console.error('[server] Failed to start', error);
    process.exitCode = 1;
  });
