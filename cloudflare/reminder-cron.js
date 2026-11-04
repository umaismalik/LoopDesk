export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.APP_URL || !env.CRON_SECRET) {
        console.error("Reminder cron is missing APP_URL or CRON_SECRET.");
        return;
      }

      try {
        const response = await fetch(`${env.APP_URL.replace(/\/+$/, "")}/api/cron`, {
          headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
        });
        if (!response.ok) {
          console.error("Reminder check failed:", response.status, await response.text());
          return;
        }
        console.log("Reminder check completed:", await response.text());
      } catch (error) {
        console.error("Could not call the reminder endpoint:", error);
      }
    })());
  },
};
