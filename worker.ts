import { httpServerHandler } from "cloudflare:node";
import { PORT } from "./constants.js";
import { app } from "./server.js";

// The port is a routing key inside the isolate, not a public socket.
// HTTP requests arrive through the Workers fetch handler below.
app.listen(PORT);

export { Ledger } from "./ledger.js";

export default httpServerHandler({ port: PORT });
