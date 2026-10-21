import { createApp } from "./app.js";
import { resumeDecisionQueue } from "./decisions/queue.js";

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`Appeal EyeQ listening on port ${port}`);
  // Decision letters that were waiting, or half-read when the server last stopped, are read now.
  resumeDecisionQueue().catch((err) => console.error(`Decision queue: couldn't resume (${err instanceof Error ? err.name : "Error"})`));
});
