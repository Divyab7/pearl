import { createInsurerApp } from "./insurer.js";

const port = Number(process.env.INSURER_PORT ?? 8090);
createInsurerApp().listen(port, () => console.log(`mock insurer on http://localhost:${port}`));
