import { httpServerHandler } from "cloudflare:node";
import { app } from "./server.js";

// The port is a routing key inside the isolate, not a public socket.
// HTTP requests arrive through the Workers fetch handler below.
app.listen(4000);

export default httpServerHandler({ port: 4000 });
