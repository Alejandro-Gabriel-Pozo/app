import { createApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const { app } = await createApp();

app.listen(PORT, () => {
  console.log(`Reservations API running on http://localhost:${PORT}`);
  console.log(`Swagger UI: http://localhost:${PORT}/docs`);
  console.log(`Health:     http://localhost:${PORT}/health`);
});
