// Shared by the Node listener and the Workers routing key. They must match.
export const PORT = 4000;

// Multer holds the CSV in memory on Workers. Stay well under the 128 MB isolate cap.
export const MAX_UPLOAD_BYTES = 5_000_000;

export const MAX_LEDGER_ROWS = 20_000;
